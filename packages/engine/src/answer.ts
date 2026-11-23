import { setTimeout as sleep } from "node:timers/promises";

import { validateWithSchema } from "@ugoke/core";
import type { PluginRegistry, WorkflowEvent } from "@ugoke/core";
import { WorkflowUpdateFailedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";

import { answerUpdateName, readStartedAt, waitingQueryName } from "./messages.js";
import type { Answer, WaitingStep } from "./messages.js";

/**
 * Intervals of checking whether the workflow waits for an answer, in milliseconds.
 *
 * The interval grows while the workflow does not wait, so that a long run sends few queries,
 * and starts again from the shortest after each answer.
 */
const minPollIntervalMs = 200;
const maxPollIntervalMs = 2000;

/** Interval of checking whether another process answered the step that this process asks. */
const answeredPollIntervalMs = 1000;

/** Message that the progress shows when another process answered the step. */
export const answeredElsewhereMessage = "Answered elsewhere, such as with ugoke inbox answer";

/** Options of {@link answerWaits}. */
export interface AnswerWaitsOptions {
  handle: WorkflowHandle;
  plugins: PluginRegistry;
  /** Reports a progress event of a wait step, and resolves after the event is shown. */
  report: (event: WorkflowEvent) => Promise<void>;
  /** Shows the events that the run has stored so far. */
  flush: () => Promise<void>;
  /**
   * Calls the listener with each `stepFinished` event before the event is shown, and returns a
   * function that stops calling it. Without it, another answer is noticed only by queries.
   */
  onStepFinished?: (
    listener: (event: Extract<WorkflowEvent, { type: "stepFinished" }>) => void,
  ) => () => void;
  /** Shows an event at once, without storing it in the log of the run. */
  notify?: (event: WorkflowEvent) => void;
  /** Stops answering when aborted, such as when the run ends or is interrupted. */
  signal: AbortSignal;
}

/**
 * Waits for a promise, but stops waiting when the signal is aborted.
 *
 * A method may ignore the signal, and the run must still be able to stop or detach.
 */
const untilAborted = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  // The promise may reject after this function stops waiting, such as when the signal was
  // aborted while the method started. Its result is not needed then.
  promise.catch(() => {});
  signal.throwIfAborted();
  const cleanup = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
      signal: cleanup.signal,
    });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    cleanup.abort();
  }
};

const formatPrefixedErrors = (prefix: string, errors: { path: unknown[]; message: string }[]) =>
  errors.map(({ message, path }) => `${[prefix, ...path].join(".")}: ${message}`).join("\n");

/** Returns whether the run still waits at a visit of a step. A query that fails says nothing. */
const stillWaits = async (
  handle: WorkflowHandle,
  step: string,
  visit: number,
): Promise<boolean> => {
  const waiting = await handle
    .query<WaitingStep | null>(waitingQueryName)
    .catch((): "unknown" => "unknown");
  return waiting === "unknown" || (waiting?.step === step && waiting.visit === visit);
};

/**
 * Aborts the returned signal when another process answers the step, such as `ugoke inbox answer`,
 * or when the given signal is aborted.
 *
 * The end of the step usually tells first, and the notice is shown before the end. A query
 * tells when the progress cannot be read.
 *
 * @returns The signals, and a function that stops watching.
 */
const watchAnswered = (
  handle: WorkflowHandle,
  { step, visit }: { step: string; visit: number },
  { notify = () => {}, onStepFinished, signal }: AnswerWaitsOptions,
): { answered: AbortSignal; asking: AbortSignal; stop: () => void } => {
  const answered = new AbortController();
  const stopped = new AbortController();
  const markAnswered = (): void => {
    if (answered.signal.aborted || stopped.signal.aborted) {
      return;
    }
    notify({ step, stream: "stderr", text: `${answeredElsewhereMessage}\n`, type: "stepOutput" });
    answered.abort(new Error(answeredElsewhereMessage));
  };
  // A cancelled step was not answered, and the cancellation stops the method by itself.
  const unsubscribe = onStepFinished?.((event) => {
    if (event.step === step && event.outcome !== "cancelled") {
      markAnswered();
    }
  });
  const check = async (): Promise<void> => {
    while (!stopped.signal.aborted && !answered.signal.aborted) {
      await sleep(answeredPollIntervalMs, undefined, { signal: stopped.signal }).catch(() => {});
      if (!stopped.signal.aborted && !(await stillWaits(handle, step, visit))) {
        markAnswered();
      }
    }
  };
  void check();
  return {
    answered: answered.signal,
    asking: AbortSignal.any([signal, answered.signal]),
    stop: () => {
      stopped.abort();
      unsubscribe?.();
    },
  };
};

/** Asks the method of a waiting step for an answer until the workflow accepts one. */
const answerStep = async (
  {
    answers,
    method: name,
    options: stepOptions,
    startedAt: reportedStart,
    step,
    visit,
    workflowInputs = {},
  }: WaitingStep,
  options: AnswerWaitsOptions,
): Promise<void> => {
  const { flush, handle, plugins, report, signal } = options;
  const method = plugins.waitMethod(name);
  if (method?.respond === undefined) {
    throw new Error(`steps.${step}: Wait method ${name} cannot answer in this process`);
  }
  const validated = validateWithSchema(method.with, stepOptions);
  if (!validated.ok) {
    throw new Error(formatPrefixedErrors(`steps.${step}.with`, validated.errors));
  }

  // Runs of earlier versions do not report when the step started to wait, so it falls back to
  // when this process first asks, which stays the same while the method asks again.
  const startedAt = readStartedAt(reportedStart, Date.now());

  // The workflow stores the start of the step before it waits, so it is shown before the
  // questions of the method.
  await flush();
  for (;;) {
    // Another process can answer the step, so the method stops asking when it does.
    const { answered, asking, stop } = watchAnswered(handle, { step, visit }, options);
    let values: Readonly<Record<string, unknown>>;
    try {
      values = await untilAborted(
        method.respond({
          answers,
          config: plugins.waitMethodConfig(name),
          // As in the temporary Worker of a run, nothing is written, to keep the progress intact.
          log: () => {},
          options: validated.value,
          run: { inputs: workflowInputs, workflowId: handle.workflowId },
          signal: asking,
          startedAt,
          step,
          visit,
        }),
        asking,
      );
    } catch (error) {
      // The notice is already shown.
      if (answered.aborted && !signal.aborted) {
        return;
      }
      throw error;
    } finally {
      stop();
    }
    try {
      const answer: Answer = { step, values, visit, workflowId: handle.workflowId };
      await handle.executeUpdate(answerUpdateName, { args: [answer] });
      return;
    } catch (error) {
      // The workflow rejected the answer, so the method asks again.
      if (!(error instanceof WorkflowUpdateFailedError)) {
        throw error;
      }
      // Another process may have answered the step in the meantime.
      const waiting = await handle.query<WaitingStep | null>(waitingQueryName).catch(() => null);
      if (waiting?.step !== step || waiting.visit !== visit) {
        return;
      }
      const reason = error.cause instanceof Error ? error.cause.message : error.message;
      await report({ step, stream: "stderr", text: `${reason}\n`, type: "stepOutput" });
    }
  }
};

/**
 * Answers the wait steps of a run with the methods of the plugins, until the signal is aborted.
 *
 * @throws When a step cannot be answered, such as when its method fails.
 */
export const answerWaits = async (options: AnswerWaitsOptions): Promise<void> => {
  const { handle, signal } = options;
  let interval = minPollIntervalMs;
  while (!signal.aborted) {
    // The query fails while no Worker can run it and after the workflow closes. The result of
    // the workflow reports those cases.
    const waiting = await handle
      .query<WaitingStep | null>(waitingQueryName)
      .catch((): WaitingStep | null => null);
    // The Worker answers a step whose method answers there, so this process only waits.
    if (waiting !== null && waiting.respondIn !== "worker" && !signal.aborted) {
      await answerStep(waiting, options);
      interval = minPollIntervalMs;
      continue;
    }
    await sleep(interval, undefined, { signal }).catch(() => {});
    interval = Math.min(interval * 2, maxPollIntervalMs);
  }
};
