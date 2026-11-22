import { resolveWorkflowInput } from "@ugoke/core";
import { jsonBytes, maxValueBytes, runWorkflow, startWorkflow } from "@ugoke/engine";

import { realpath } from "node:fs/promises";

import { reportAiFailure, writeAiLine } from "../ai.js";
import { cancelledExitCode } from "../exit-codes.js";
import { followRun, rootMessage } from "../follow.js";
import { readWorkflowInput } from "../input.js";
import { acquireRunLock } from "../lock.js";
import type { RunLock } from "../lock.js";
import { openCommandServer } from "../daemon/connect.js";
import { loadEncryptionKey } from "../encryption.js";
import type { ServerOptions } from "../server.js";
import { projectHash, projectLockDirectory, projectMemoKey, workflowMemoKey } from "../state.js";
import { loadWorkflow } from "./load.js";
import type { CommandContext } from "./load.js";

/** Options of {@link run}. */
export interface RunOptions {
  /** Value of `--input`: a JSON object, or the path of a `.json` file. */
  input?: string | undefined;
  /**
   * Temporal Server that runs the workflow. Without it, the resident process of this host runs
   * the steps.
   */
  server?: ServerOptions | undefined;
  /** Aborted when the user interrupts, which detaches the run. */
  signal: AbortSignal;
  /** Configures the Temporal runtime, right before the run starts. */
  prepareEngine?: () => void;
  /**
   * Starts the run and exits without following it. The resident process runs the steps, and
   * the questions of the run wait in `ugoke inbox list`.
   */
  detach?: boolean | undefined;
  /**
   * Writes JSON lines for a program such as an AI agent, and exits at the first question, which
   * `ugoke inbox answer --from-ai` answers. See {@link followRun}.
   */
  fromAi?: boolean | undefined;
  /**
   * Version of this ugoke. When the server is not given, a resident process of the same version
   * runs the steps.
   */
  version: string;
}

/**
 * Runs a workflow and waits for it to finish.
 *
 * Scripts run in the project root.
 *
 * @returns The exit code of the command.
 */
export const run = async (
  name: string,
  options: RunOptions,
  context: CommandContext,
): Promise<number> => {
  if (options.fromAi !== true) {
    return runWorkflowCommand(name, options, context);
  }
  return reportAiFailure(context, async (watched) => runWorkflowCommand(name, options, watched));
};

const runWorkflowCommand = async (
  name: string,
  {
    detach = false,
    fromAi = false,
    input: inputOption,
    prepareEngine,
    server,
    signal,
    version,
  }: RunOptions,
  context: CommandContext,
): Promise<number> => {
  const workflow = await loadWorkflow(name, context);
  if (workflow === undefined) {
    return 1;
  }

  const read =
    inputOption === undefined
      ? { ok: true as const, values: {} }
      : await readWorkflowInput(inputOption, context.cwd);
  if (!read.ok) {
    context.stderr(`${name}: ${read.message}\n`);
    return 1;
  }
  // The workflow validates the input again, but checking it here avoids starting a server.
  const resolved = resolveWorkflowInput(workflow.intermediate.inputs, read.values);
  if (!resolved.ok) {
    for (const { message, path } of resolved.errors) {
      context.stderr(`${name}: ${["workflow.inputs", ...path].join(".")}: ${message}\n`);
    }
    return 1;
  }
  const bytes = jsonBytes(resolved.inputs);
  if (bytes > maxValueBytes) {
    context.stderr(
      `${name}: workflow.inputs is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes\n`,
    );
    return 1;
  }

  try {
    const root = await realpath(workflow.root);
    const { server: opened, servedTaskQueue } = await openCommandServer(
      { detach, server, version },
      root,
      context,
    );
    if (signal.aborted) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }

    const memo = { [projectMemoKey]: projectHash(root), [workflowMemoKey]: name };
    if (detach) {
      // The run goes on after this command only in the resident process. The reason why it does
      // not run the steps is already shown.
      if (servedTaskQueue === undefined) {
        context.stderr(`${name}: cannot detach, because ugoke daemon does not run the steps\n`);
        return 1;
      }
      const workflowId = await startWorkflow({
        address: opened.address,
        encryptionKey: loadEncryptionKey(),
        inputs: read.values,
        intermediate: workflow.intermediate,
        memo,
        name,
        taskQueue: servedTaskQueue,
      });
      context.stdout(
        `${name}: started ${workflowId} in ugoke daemon. Its questions wait in "ugoke inbox list", and "ugoke attach ${workflowId}" follows it\n`,
      );
      return 0;
    }

    let lock: RunLock | undefined;
    try {
      return await followRun(
        {
          fromAi,
          follow: async (options) =>
            runWorkflow({
              ...options,
              inputs: read.values,
              intermediate: workflow.intermediate,
              // The memo marks the run, so that ugoke attach can find the runs of a project.
              memo,
              name,
              // ugoke attach does not follow a run that this process follows.
              onStart: (workflowId) => {
                lock = acquireRunLock(projectLockDirectory(root), workflowId);
                if (fromAi) {
                  writeAiLine(context.stdout, { name, type: "started", workflowId });
                }
              },
              // The resident process runs the steps on the task queue of the project.
              ...(servedTaskQueue === undefined
                ? {}
                : { startWorker: false, taskQueue: servedTaskQueue }),
            }),
          interrupt: signal,
          name,
          ownsWorker: servedTaskQueue === undefined,
          prepareEngine,
          root,
          server: opened,
          steps: Object.keys(workflow.intermediate.steps),
        },
        context,
      );
    } finally {
      lock?.release();
    }
  } catch (error) {
    // An interrupt while the command connects stops it before the run starts.
    if (signal.aborted) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }
    context.stderr(`${name}: failed: ${rootMessage(error)}\n`);
    return 1;
  }
};
