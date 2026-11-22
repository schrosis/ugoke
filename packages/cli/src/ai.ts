import { terminalWaitMethod } from "@ugoke/adapter-wait-terminal";
import { definePlugin, defineWaitMethod } from "@ugoke/core";
import type { InputDeclaration, Plugin, WorkflowEvent } from "@ugoke/core";

import { cancelledExitCode } from "./exit-codes.js";

/**
 * Output of `--from-ai`, which a program such as an AI agent reads instead of a person.
 *
 * Each line of standard output is one JSON object of these types.
 */
export type AiLine =
  | { type: "started"; workflowId: string; name: string }
  | { type: "answered"; workflowId: string; step: string; visit?: number | undefined }
  | Exclude<WorkflowEvent, { type: "stepOutput" }>
  | AiQuestion
  | { type: "warning"; message: string }
  /** A run of `ugoke inbox list` whose wait could not be read, such as when no Worker serves it. */
  | { type: "unreadable"; workflowId: string; reason: string }
  /** The run detached without a question, such as on Ctrl+C. */
  | { type: "detached"; workflowId: string }
  | { type: "completed"; workflowId: string; executedSteps: string[] }
  | { type: "failed"; message: string }
  | { type: "cancelled" };

/** A wait step that waits for an answer, as `--from-ai` reports it. */
export interface AiQuestion {
  type: "question";
  workflowId: string;
  /** Name of the workflow, when the run records it. */
  name?: string | undefined;
  step: string;
  /** Visit of the step, which `ugoke inbox answer --visit` takes. */
  visit: number;
  /** Message of the step, from the `message` option of its method. */
  message?: string | undefined;
  /** Declarations of the answers, which `ugoke inbox answer --values` gives. */
  answers: Readonly<Record<string, InputDeclaration>>;
  /** Values of the workflow input, which tell runs of the same workflow apart. */
  inputs?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Whether ugoke daemon runs the run, which `ugoke inbox answer --detach` needs. Only
   * `ugoke inbox list` tells it.
   */
  inDaemon?: boolean | undefined;
}

/** Writes a line of the output of `--from-ai`. */
export const writeAiLine = (stdout: (text: string) => void, line: AiLine): void => {
  stdout(`${JSON.stringify(line)}\n`);
};

/**
 * Runs a command of `--from-ai`, and ends its output with a `failed` line when it fails without
 * writing any line, such as when a definition is invalid. An interrupt before any line, such as
 * while the command connects, ends it with a `cancelled` line instead.
 *
 * The messages for a person still go to standard error, and the line repeats them.
 *
 * @param run Runs the command with a context whose output is watched.
 */
export const reportAiFailure = async <Context extends CommandOutput>(
  context: Context,
  run: (context: Context) => Promise<number>,
): Promise<number> => {
  let errors = "";
  let wrote = false;
  const exitCode = await run({
    ...context,
    stderr: (text: string) => {
      errors += text;
      context.stderr(text);
    },
    stdout: (text: string) => {
      wrote = true;
      context.stdout(text);
    },
  });
  if (exitCode === cancelledExitCode && !wrote) {
    writeAiLine(context.stdout, { type: "cancelled" });
  } else if (exitCode !== 0 && !wrote) {
    writeAiLine(context.stdout, { message: errors.trim() || "The command failed", type: "failed" });
  }
  return exitCode;
};

/** The output that {@link reportAiFailure} watches. */
interface CommandOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Creates the plugin of the `terminal` wait method for `--from-ai`.
 *
 * Instead of asking in the terminal, the method reports the question and keeps waiting until the
 * command stops following the run, which the caller does when it is told of the question.
 *
 * @param onQuestion Receives each question, such as to report it and detach the run.
 */
export const createAiTerminalPlugin = (onQuestion: (question: AiQuestion) => void): Plugin =>
  definePlugin({
    name: "terminal",
    waitMethods: [
      defineWaitMethod({
        ...terminalWaitMethod,
        respond: async ({ answers, options, run, signal, step, visit }) => {
          onQuestion({
            answers,
            inputs: run.inputs,
            message: options.message,
            step,
            type: "question",
            visit,
            workflowId: run.workflowId,
          });
          // Another process answers, and this process stops following the run.
          return new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
    ],
  });
