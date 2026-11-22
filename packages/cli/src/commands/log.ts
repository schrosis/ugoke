import { realpath } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { createFileEventLog } from "@ugoke/adapter-event-log-file";
import type { WorkflowEvent } from "@ugoke/core";
import { followEvents, watchWorkflowStatus } from "@ugoke/engine";
import type { WorkflowStatusWatcher } from "@ugoke/engine";

import { readProjectConfig } from "../config.js";
import { openCommandServer } from "../daemon/connect.js";
import { loadEncryptionKey } from "../encryption.js";
import { rootMessage } from "../follow.js";
import { createProgressPrinter } from "../progress.js";
import type { ServerOptions } from "../server.js";
import { projectLogDirectory } from "../state.js";
import { ugokeDirectory, findProjectRoot } from "../workflows.js";
import type { CommandContext } from "./load.js";
import { stepOrder } from "./attach.js";

/** Interval of checking whether a followed run still runs, in milliseconds. */
const runningPollIntervalMs = 1000;

/** Options of {@link log}. */
export interface LogOptions {
  workflowId: string;
  /** Shows only the last lines of the progress that the run stored so far. */
  tail?: number | undefined;
  /** Keeps showing the progress until the run ends. */
  follow?: boolean | undefined;
  /** Writes each event as a line of JSON instead of the progress for a person. */
  json?: boolean | undefined;
  /**
   * Temporal Server that keeps the run, which `follow` asks whether the run still runs. Without
   * it, the server of the project or of the resident process is used.
   */
  server?: ServerOptions | undefined;
  /** Aborted when the user interrupts, which stops following. */
  signal: AbortSignal;
  version: string;
}

/** Workflow IDs end with a UUID after the name of the workflow, such as `release/notes-<uuid>`. */
const workflowName = (workflowId: string): string | undefined =>
  /^(?<name>.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.exec(workflowId)
    ?.groups?.name;

/**
 * Keeps the last lines of a text, not counting the empty lines at its end, such as the line that
 * separates the steps.
 */
const lastLines = (text: string, count: number | undefined): string => {
  if (count === undefined) {
    return text;
  }
  const lines = text.replace(/\n+$/u, "").split("\n");
  const kept = count === 0 || text.trim() === "" ? [] : lines.slice(-count);
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
};

/** Shows events, for a person or as JSON, first into a text and then directly. */
interface EventView {
  emit: (event: WorkflowEvent) => void;
  /** Writes what was shown into the text, keeping its last lines, and shows the rest directly. */
  flush: (tail: number | undefined) => void;
  close: () => void;
}

const createView = async (
  { json = false, workflowId }: Pick<LogOptions, "json" | "workflowId">,
  root: string,
  context: CommandContext,
): Promise<EventView> => {
  // Until the earlier progress is cut to its last lines, it is collected here.
  let collected: string | undefined = "";
  const write = (text: string): void => {
    if (collected === undefined) {
      context.stdout(text);
    } else {
      collected += text;
    }
  };
  const flush = (tail: number | undefined): void => {
    const text = lastLines(collected ?? "", tail);
    collected = undefined;
    context.stdout(text);
  };
  if (json) {
    return {
      close: () => {},
      emit: (event) => write(`${JSON.stringify(event)}\n`),
      flush,
    };
  }
  const read = await readProjectConfig(root, context.cwd);
  const name = workflowName(workflowId);
  // Both streams of a step go to standard output, so that its lines stay in their order.
  const printer = createProgressPrinter(
    { stderr: write, stdout: write },
    {
      colors: { stderr: context.colors?.stdout === true, stdout: context.colors?.stdout === true },
      showCommands: read.config.output?.showCommands,
      steps: name === undefined ? undefined : await stepOrder(root, name),
    },
  );
  return { close: () => printer.close(), emit: (event) => printer.emit(event), flush };
};

/**
 * Shows the progress of a run of the project, which the log of the project keeps.
 *
 * The progress of a finished run is shown too. Following a run asks the Temporal Server whether
 * it still runs.
 *
 * @returns The exit code of the command.
 */
export const log = async (options: LogOptions, context: CommandContext): Promise<number> => {
  const { follow = false, signal, tail, workflowId } = options;
  const found = await findProjectRoot(context.cwd);
  if (found === undefined) {
    context.stderr(`No ${ugokeDirectory} directory found in ${context.cwd} or its parents\n`);
    return 1;
  }
  const root = await realpath(found);
  const eventLog = createFileEventLog({ directory: projectLogDirectory(root) });
  let watcher: WorkflowStatusWatcher | undefined;
  try {
    if (follow) {
      const { server } = await openCommandServer(options, root, context);
      watcher = await watchWorkflowStatus({
        address: server.address,
        encryptionKey: loadEncryptionKey(),
        workflowId,
      });
    }
    // The status is asked before the log is read. A run that ended then has stored all of its
    // events, and one that runs is followed until its end, so no event is missed.
    const stillRunning = (await watcher?.running()) ?? false;
    const { cursor, events } = await eventLog.read(workflowId);
    if (events.length === 0 && !stillRunning) {
      context.stderr(`No progress of ${workflowId} in this project\n`);
      return 1;
    }
    const view = await createView(options, root, context);
    try {
      for (const event of events) {
        view.emit(event);
      }
      view.flush(tail);
      if (watcher === undefined || !stillRunning) {
        return 0;
      }
      const follower = followEvents({ cursor, log: eventLog, runId: workflowId, sink: view });
      try {
        while (!signal.aborted && (await watcher.running())) {
          await sleep(runningPollIntervalMs, undefined, { signal }).catch(() => {});
        }
      } finally {
        // The last events of the run are stored before it ends.
        await follower.stop();
      }
      return 0;
    } finally {
      view.close();
    }
  } catch (error) {
    context.stderr(`${rootMessage(error)}\n`);
    return 1;
  } finally {
    await watcher?.close();
  }
};
