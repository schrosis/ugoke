import { Writable } from "node:stream";

import { createFileEventLog } from "@ugoke/adapter-event-log-file";
import type { TerminalIO, TerminalStreams } from "@ugoke/adapter-wait-terminal";
import { createLocalScriptRunner } from "@ugoke/adapter-script-local";
import { createAiRunner } from "@ugoke/core";
import type { EventSink } from "@ugoke/core";
import { IncompatibleRunError } from "@ugoke/engine";
import type { FollowOptions, RunOutcome } from "@ugoke/engine";

import { createAiTerminalPlugin, writeAiLine } from "./ai.js";
import type { AiLine } from "./ai.js";
import type { CommandContext } from "./commands/load.js";
import { loadEncryptionKey } from "./encryption.js";
import { createEnvironmentReader } from "./environment.js";
import { cancelledExitCode, detachedExitCode } from "./exit-codes.js";
import { createLineReader } from "./lines.js";
import type { LineReader } from "./lines.js";
import { readProjectConfig } from "./config.js";
import { createRegistry, createRegistryWith, loadConfiguredPlugins } from "./plugins.js";
import { createProgressPrinter } from "./progress.js";
import type { ProgressPrinter } from "./progress.js";
import type { OpenedServer } from "./server.js";
import { projectLogDirectory } from "./state.js";

/** Returns whether an error of the engine means that the run was cancelled. */
export const isCancelled = (error: unknown): boolean =>
  error instanceof Error && error.cause instanceof Error && error.cause.name === "CancelledFailure";

/** Returns the message of the innermost cause, which describes the actual failure. */
export const rootMessage = (error: unknown): string => {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
};

/** Creates the output of interactive prompts, which writes to standard output of the command. */
const createPromptOutput = (
  stdout: (text: string) => void,
  columns: () => number,
): NodeJS.WritableStream => {
  const output = new Writable({
    write: (chunk: Buffer | string, _encoding, callback) => {
      stdout(chunk.toString());
      callback();
    },
  });
  // The prompts wrap their lines to the width of the terminal.
  Object.defineProperty(output, "columns", { get: columns });
  return output;
};

/**
 * Creates the terminal that wait steps ask in. Standard input is opened only when it is read.
 *
 * When both standard input and output are terminals, wait steps ask with interactive prompts.
 */
export const createTerminal = (
  context: CommandContext,
): TerminalIO & { close: () => void; endLine: () => void } => {
  let lines: LineReader | undefined;
  let echo = false;
  // Whether a question left its line open, such as a prompt that waits for the answer.
  let lineOpen = false;
  const write = (text: string): void => {
    if (text.length > 0) {
      context.stdout(text);
      lineOpen = !text.endsWith("\n");
    }
  };
  return {
    close: () => lines?.close(),
    endLine: () => {
      if (lineOpen) {
        write("\n");
      }
    },
    interactive: (): TerminalStreams | undefined => {
      const { columns, interrupt, stdin } = context;
      if (stdin === undefined || columns === undefined || interrupt === undefined) {
        return undefined;
      }
      const input = stdin();
      if (!("isTTY" in input && input.isTTY === true)) {
        return undefined;
      }
      // A prompt reads the keys, so lines are read again by a new reader after it.
      lines?.close();
      lines = undefined;
      return { input, interrupt, output: createPromptOutput(write, columns) };
    },
    readLine: async (signal) => {
      if (context.stdin === undefined) {
        return null;
      }
      if (lines === undefined) {
        const input = context.stdin();
        // A terminal shows what is typed. Piped answers are shown here instead.
        echo = !("isTTY" in input && input.isTTY === true);
        lines = createLineReader(input);
      }
      const line = await lines.readLine(signal);
      if (line !== null) {
        // A terminal ends the line when Enter is pressed.
        lineOpen = false;
        if (echo) {
          write(`${line}\n`);
        }
      }
      return line;
    },
    write,
  };
};

/** Options of {@link followRun}. */
export interface FollowRunOptions {
  /** Name of the workflow, which prefixes the messages. */
  name: string;
  /** Real path of the project root, where scripts run and logs are kept. */
  root: string;
  /** IDs of the steps in the order of the definition, which gives each step its color. */
  steps?: readonly string[] | undefined;
  server: OpenedServer;
  /**
   * Aborted when the user interrupts. It detaches the run, so that a process can attach to it
   * later.
   */
  interrupt: AbortSignal;
  /**
   * Configures the Temporal runtime, right before {@link FollowRunOptions.follow}.
   *
   * An installed runtime keeps the process alive until a Worker shuts it down, so it must not be
   * installed when the command returns before it follows the run.
   */
  prepareEngine?: (() => void) | undefined;
  /** Starts the run, or attaches to it, with the options that this module prepares. */
  follow: (options: FollowOptions) => Promise<RunOutcome>;
  /** Terminal that wait steps ask in, when the command already reads standard input. */
  terminal?: ReturnType<typeof createTerminal>;
  /**
   * Whether this process runs the scripts of the run. A run that a resident process serves
   * detaches at once, because its scripts keep running there.
   */
  ownsWorker?: boolean;
  /**
   * Writes JSON lines for a program such as an AI agent, instead of the progress for a person,
   * and detaches the run at the first question of a `terminal` step, which `ugoke inbox answer`
   * answers. Steps that a Worker answers, such as a wait for CI, are followed through.
   */
  fromAi?: boolean;
}

/**
 * Follows a run in the terminal and reports how it ended.
 *
 * @returns The exit code of the command.
 */
export const followRun = async (
  {
    follow,
    fromAi = false,
    interrupt,
    name,
    ownsWorker = true,
    prepareEngine,
    root,
    server,
    steps,
    terminal: given,
  }: FollowRunOptions,
  context: CommandContext,
): Promise<number> => {
  const terminal = given ?? createTerminal(context);
  const write = (line: AiLine): void => writeAiLine(context.stdout, line);
  // The configuration file decides what the progress shows, once it is read below.
  let printer: ProgressPrinter | undefined;
  // The script or AI step that runs now, so that an interrupt can tell that the run waits for it.
  let runningStep: string | undefined;
  const eventSink: EventSink = {
    emit: (event) => {
      if (event.type === "stepStarted") {
        runningStep =
          event.run === undefined && event.provider === undefined ? undefined : event.step;
      } else if (event.type === "stepFinished") {
        runningStep = undefined;
      }
      if (fromAi) {
        // The output of steps can be long, and a program reads it with ugoke log if needed.
        if (event.type !== "stepOutput") {
          write(event);
        }
        return;
      }
      // A question that another process answered leaves its prompt open.
      terminal.endLine();
      printer?.emit(event);
    },
  };

  const detach = new AbortController();
  // Whether the run detached at a question of --from-ai, which is then the last line.
  let asked = false;
  const onInterrupt = (): void => {
    printer?.clear();
    // The interrupt can come while a question waits on the same line.
    if (!fromAi) {
      context.stdout("\n");
    }
    if (ownsWorker && runningStep !== undefined) {
      context.stderr(
        "Waiting for the running step to finish, so that you can attach to the run later.\n" +
          "Press Ctrl+C again to exit now. The running step will fail, and the run cannot be continued.\n",
      );
    }
    detach.abort();
  };
  interrupt.addEventListener("abort", onInterrupt, { once: true });

  try {
    // The file is read once, so that the progress and the plugins follow the same contents.
    const read = await readProjectConfig(root, context.cwd);
    printer = fromAi
      ? undefined
      : createProgressPrinter(context, {
          colors: context.colors,
          showCommands: read.config.output?.showCommands,
          // A status line needs a terminal, which can move the cursor back over it.
          status: context.columns === undefined ? undefined : { columns: context.columns },
          steps,
        });
    // Plugins load before the run starts, so that a broken one stops nothing.
    const loaded = await loadConfiguredPlugins(read, root);
    // The key is read first, because a process with a prepared engine does not exit by itself
    // until it reaches the server.
    const encryptionKey = loadEncryptionKey();
    prepareEngine?.();
    const following = follow({
      address: server.address,
      eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
      eventSink,
      onWarning: (message) => {
        if (fromAi) {
          write({ message, type: "warning" });
          return;
        }
        // A warning comes while a step runs, so it must not run into the status line.
        printer?.clear();
        context.stderr(`${name}: warning: ${message}\n`);
      },
      aiRunner: createAiRunner({ cwd: root, plugins: createRegistry(undefined, loaded) }),
      encryptionKey,
      plugins: fromAi
        ? createRegistryWith(
            createAiTerminalPlugin((question) => {
              if (!asked) {
                asked = true;
                write({ ...question, name });
                detach.abort();
              }
            }),
            loaded,
          )
        : createRegistry(terminal, loaded),
      readEnvironment: createEnvironmentReader(root),
      scriptRunner: createLocalScriptRunner({ cwd: root }),
      detach: detach.signal,
    });
    // The status line is removed before the result of the run is written.
    const outcome = await following.finally(() => printer?.close());
    if (outcome.status === "detached") {
      if (fromAi) {
        if (!asked) {
          write({ type: "detached", workflowId: outcome.workflowId });
        }
        return detachedExitCode;
      }
      context.stderr(`${name}: detached. Run "ugoke attach${server.options}" to continue\n`);
      return detachedExitCode;
    }
    if (fromAi) {
      write({
        executedSteps: outcome.executedSteps,
        type: "completed",
        workflowId: outcome.workflowId,
      });
      return 0;
    }
    context.stdout(`${name}: completed (${outcome.executedSteps.join(", ")})\n`);
    return 0;
  } catch (error) {
    if (fromAi) {
      if (isCancelled(error) || interrupt.aborted) {
        write({ type: "cancelled" });
        return cancelledExitCode;
      }
      write({ message: rootMessage(error), type: "failed" });
      return 1;
    }
    if (isCancelled(error) || interrupt.aborted) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }
    if (error instanceof IncompatibleRunError) {
      context.stderr(
        `${name}: ${error.message}. Attach to it with the version of ugoke that started it, or pass --force to try anyway\n`,
      );
      return 1;
    }
    context.stderr(`${name}: failed: ${rootMessage(error)}\n`);
    return 1;
  } finally {
    // The run may not have started, such as when a plugin cannot be loaded.
    printer?.close();
    interrupt.removeEventListener("abort", onInterrupt);
    // A terminal that the caller passed is closed by the caller.
    if (given === undefined) {
      terminal.close();
    }
  }
};
