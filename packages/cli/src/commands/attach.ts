import { readFile, realpath } from "node:fs/promises";

import { createFileEventLog } from "@ugoke/adapter-event-log-file";
import { createLocalScriptRunner } from "@ugoke/adapter-script-local";
import { parseDefinition } from "@ugoke/definition";
import { attachWorkflow, terminateWorkflow } from "@ugoke/engine";

import { cancelledExitCode } from "../exit-codes.js";
import { createTerminal, followRun, isCancelled, rootMessage } from "../follow.js";
import { loadEncryptionKey } from "../encryption.js";
import { acquireRunLock, RunLockedError } from "../lock.js";
import { chooseRun, listProjectRuns } from "../runs.js";
import type { ProjectRun } from "../runs.js";
import { openCommandServer } from "../daemon/connect.js";
import type { CommandServer } from "../daemon/connect.js";
import type { ServerOptions } from "../server.js";
import { projectLockDirectory, projectLogDirectory } from "../state.js";
import { ugokeDirectory, findProjectRoot, resolveWorkflow } from "../workflows.js";
import type { CommandContext } from "./load.js";

/** Options of {@link attach} and {@link cancel}. */
export interface AttachOptions {
  /** ID of the run. Without it, the command lists the runs of the project to choose from. */
  workflowId?: string | undefined;
  /**
   * Temporal Server that keeps the runs. Without it, the resident process of this host serves
   * the command.
   */
  server?: ServerOptions | undefined;
  /** Aborted when the user interrupts. */
  signal: AbortSignal;
  /** Called before the command runs a Worker. */
  prepareEngine?: () => void;
  /** Attaches to a run that another version of ugoke started, which can fail. */
  force?: boolean | undefined;
  /**
   * Version of this ugoke. When the server is not given, a resident process of the same version
   * continues the runs that it serves.
   */
  version: string;
}

type Selected = { ok: true; run: ProjectRun } | { ok: false; exitCode: number };

/**
 * Returns the IDs of the steps of a workflow in the order of its definition, which gives each
 * step its color.
 *
 * The definition may have changed or gone since the run started, so the steps then get colors in
 * the order that they run.
 */
export const stepOrder = async (root: string, name: string): Promise<string[] | undefined> => {
  const resolved = await resolveWorkflow(root, name);
  if (!resolved.ok) {
    return undefined;
  }
  try {
    const parsed = parseDefinition(await readFile(resolved.file, "utf8"));
    return parsed.ok ? Object.keys(parsed.definition.steps) : undefined;
  } catch {
    return undefined;
  }
};

/** Finds the real path of the project root. */
const findRoot = async (context: CommandContext): Promise<string | undefined> => {
  const found = await findProjectRoot(context.cwd);
  if (found === undefined) {
    context.stderr(`No ${ugokeDirectory} directory found in ${context.cwd} or its parents\n`);
    return undefined;
  }
  return realpath(found);
};

/**
 * Returns the task queue whose runs the resident process runs, for a run on a task queue.
 *
 * A resident process of another ugoke version still serves the task queue of the project when it
 * has the same workflow code version, so a run on that queue goes on there, and the command must
 * not run a second Worker for it.
 */
const daemonQueueOf = (
  { pollingTaskQueue, servedTaskQueue }: CommandServer,
  taskQueue: string,
): string | undefined =>
  servedTaskQueue ?? (taskQueue === pollingTaskQueue ? pollingTaskQueue : undefined);

/**
 * Selects a running run of the project, by its ID or by asking in the terminal.
 *
 * @param action What the command does with the run, such as `attach`, for messages.
 */
const selectRun = async (
  action: "cancel" | "attach",
  { address, root }: { address: string; root: string },
  { signal, workflowId }: AttachOptions,
  context: CommandContext,
  terminal: ReturnType<typeof createTerminal>,
): Promise<Selected> => {
  const runs = await listProjectRuns(address, root);
  if (workflowId !== undefined) {
    const run = runs.find((candidate) => candidate.workflowId === workflowId);
    if (run === undefined) {
      context.stderr(`No running run ${workflowId} in this project\n`);
      return { exitCode: 1, ok: false };
    }
    return { ok: true, run };
  }
  if (runs.length === 0) {
    context.stdout(`No runs to ${action === "attach" ? "attach to" : action} in this project\n`);
    return { exitCode: 0, ok: false };
  }
  const run = await chooseRun(runs, terminal, signal);
  if (run === undefined) {
    context.stderr("No run was selected\n");
    return { exitCode: 1, ok: false };
  }
  return { ok: true, run };
};

/**
 * Attaches to a run of the project and follows it, such as after the process that started it
 * exited. When no Worker runs it, the command runs one, so the run goes on.
 *
 * @returns The exit code of the command.
 */
export const attach = async (options: AttachOptions, context: CommandContext): Promise<number> => {
  const { prepareEngine, signal } = options;
  const root = await findRoot(context);
  if (root === undefined) {
    return 1;
  }
  const terminal = createTerminal(context);
  try {
    const opened = await openCommandServer(options, root, context);
    const { server } = opened;
    const selected = await selectRun(
      "attach",
      { address: server.address, root },
      options,
      context,
      terminal,
    );
    if (!selected.ok) {
      return selected.exitCode;
    }
    const { run } = selected;
    const servedTaskQueue = daemonQueueOf(opened, run.taskQueue);
    if (opened.servedTaskQueue === undefined && servedTaskQueue !== undefined) {
      context.stderr(
        `${run.name}: ugoke daemon goes on running the steps of this run, because the run is on its task queue, so this command follows it without its own Worker\n`,
      );
    }
    let lock;
    try {
      lock = acquireRunLock(projectLockDirectory(root), run.workflowId);
    } catch (error) {
      if (error instanceof RunLockedError) {
        context.stderr(`${run.name}: ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    try {
      return await followRun(
        {
          follow: async (followOptions) =>
            attachWorkflow({
              ...followOptions,
              force: options.force === true,
              servedTaskQueue,
              workflowId: run.workflowId,
            }),
          interrupt: signal,
          name: run.name,
          prepareEngine,
          steps: await stepOrder(root, run.name),
          ownsWorker: run.taskQueue !== servedTaskQueue,
          root,
          server,
          terminal,
        },
        context,
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    if (signal.aborted) {
      context.stderr("Interrupted\n");
      return cancelledExitCode;
    }
    context.stderr(`${rootMessage(error)}\n`);
    return 1;
  } finally {
    terminal.close();
  }
};

/**
 * Cancels a run of the project, stopping its wait or its running script.
 *
 * @returns The exit code of the command.
 */
export const cancel = async (options: AttachOptions, context: CommandContext): Promise<number> => {
  const { prepareEngine, signal } = options;
  const root = await findRoot(context);
  if (root === undefined) {
    return 1;
  }
  const terminal = createTerminal(context);
  try {
    const opened = await openCommandServer(options, root, context);
    const { server } = opened;
    const selected = await selectRun(
      "cancel",
      { address: server.address, root },
      options,
      context,
      terminal,
    );
    if (!selected.ok) {
      return selected.exitCode;
    }
    const { run } = selected;
    prepareEngine?.();
    // Workflow code of another version could not replay the run to cancel it, so the run is
    // terminated without running its code.
    if (!run.compatible) {
      const why =
        run.version === undefined
          ? "it records no workflow code version"
          : `workflow code version ${run.version} started it`;
      await terminateWorkflow({
        address: server.address,
        reason: `Cancelled by ugoke cancel. It was terminated, because ${why}`,
        workflowId: run.workflowId,
      });
      context.stdout(
        `${run.name}: terminated instead of cancelled, because ${why}. Its running script, if any, stops at its next heartbeat\n`,
      );
      return 0;
    }
    // A Worker runs the cancellation, in case no other process follows the run.
    const outcome = await attachWorkflow({
      address: server.address,
      cancel: true,
      encryptionKey: loadEncryptionKey(),
      // The end of the cancelled step is recorded in the same log as the rest of the run.
      eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
      servedTaskQueue: daemonQueueOf(opened, run.taskQueue),
      scriptRunner: createLocalScriptRunner({ cwd: root }),
      workflowId: run.workflowId,
    }).catch((error: unknown) => {
      if (isCancelled(error)) {
        return "cancelled" as const;
      }
      throw error;
    });
    if (outcome === "cancelled") {
      context.stdout(`${run.name}: cancelled\n`);
      return 0;
    }
    context.stdout(`${run.name}: ${outcome.status} before it was cancelled\n`);
    return 0;
  } catch (error) {
    if (signal.aborted) {
      context.stderr("Interrupted\n");
      return cancelledExitCode;
    }
    context.stderr(`${rootMessage(error)}\n`);
    return 1;
  } finally {
    terminal.close();
  }
};
