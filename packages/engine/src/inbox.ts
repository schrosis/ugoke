import { Client, Connection, WorkflowUpdateFailedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";

import { clientDataConverter } from "./encryption.js";
import { answerUpdateName, waitingQueryName } from "./messages.js";
import type { Answer, WaitingStep } from "./messages.js";
import { listRunningWorkflows } from "./run.js";
import type { RunningWorkflow } from "./run.js";

/**
 * Time that a query of a run may take, in milliseconds.
 *
 * A query waits for a Worker of the run, so a run that no Worker serves would hold the listing.
 */
const queryTimeoutMs = 5000;

/** A wait step that waits for someone to answer it, with the run that it belongs to. */
export interface InboxQuestion extends WaitingStep {
  run: RunningWorkflow;
}

/** A run whose wait could not be read, such as when no Worker serves it. */
export interface UnreadableRun {
  run: RunningWorkflow;
  /** Why the run could not be read. */
  reason: string;
}

/** Result of {@link listInbox}. */
export interface Inbox {
  /** The questions, of the most recent runs first. */
  questions: InboxQuestion[];
  unreadable: UnreadableRun[];
}

/** Options of {@link listInbox}. */
export interface ListInboxOptions {
  address: string;
  namespace?: string;
  /** Lists only the runs whose memo has these values, such as the runs of a project. */
  memo?: Readonly<Record<string, string>>;
  /** Key that encrypts what goes through Temporal. */
  encryptionKey?: Uint8Array | undefined;
}

/** Returns whether a waiting step waits for an answer that someone sends to the run. */
const asksSomeone = ({ respondIn }: WaitingStep): boolean =>
  respondIn === undefined || respondIn === "follower";

const reasonOf = (error: unknown): string => {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
};

/**
 * Lists the wait steps that wait for someone to answer them, such as `terminal` steps.
 *
 * Steps that a Worker answers, such as a wait for CI, are not listed.
 */
export const listInbox = async ({
  address,
  encryptionKey,
  memo,
  namespace = "default",
}: ListInboxOptions): Promise<Inbox> => {
  const runs = await listRunningWorkflows({
    address,
    encryptionKey,
    namespace,
    ...(memo === undefined ? {} : { memo }),
  });
  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace, ...clientDataConverter(encryptionKey) });
    const read = await Promise.all(
      runs.map(async (run) => {
        try {
          const waiting = await connection.withDeadline(Date.now() + queryTimeoutMs, async () =>
            client.workflow.getHandle(run.workflowId).query<WaitingStep | null>(waitingQueryName),
          );
          return { ok: true as const, run, waiting };
        } catch (error) {
          return { ok: false as const, reason: reasonOf(error), run };
        }
      }),
    );
    const inbox: Inbox = { questions: [], unreadable: [] };
    for (const entry of read) {
      if (!entry.ok) {
        inbox.unreadable.push({ reason: entry.reason, run: entry.run });
      } else if (entry.waiting !== null && asksSomeone(entry.waiting)) {
        inbox.questions.push({ ...entry.waiting, run: entry.run });
      }
    }
    return inbox;
  } finally {
    await connection.close();
  }
};

/** Thrown when a run does not take an answer, such as when the step no longer waits. */
export class AnswerRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerRejectedError";
  }
}

/** An answer to a wait step of a run. */
export interface StepAnswer {
  /** ID of the step that the answer is for. */
  step: string;
  /** Visit of the step that the answer is for. Defaults to the visit that waits now. */
  visit?: number | undefined;
  /** Values of the answers, keyed by name. */
  values: Readonly<Record<string, unknown>>;
}

/**
 * Sends an answer to a run, which a Worker of the run must serve.
 *
 * The answer that is sent always names the run, with its run ID, and the visit, so a copy of it
 * answers nothing else.
 *
 * @throws {AnswerRejectedError} When the run rejects the answer.
 */
export const sendAnswer = async (
  handle: WorkflowHandle,
  { step, values, visit }: StepAnswer,
): Promise<void> => {
  const waitingVisit = visit ?? (await handle.query<WaitingStep | null>(waitingQueryName))?.visit;
  if (waitingVisit === undefined) {
    throw new AnswerRejectedError(`Step ${step} is not waiting for an answer`);
  }
  const { runId } = await handle.describe();
  const answer: Answer = {
    runId,
    step,
    values,
    visit: waitingVisit,
    workflowId: handle.workflowId,
  };
  await handle.executeUpdate(answerUpdateName, { args: [answer] }).catch((error: unknown) => {
    if (error instanceof WorkflowUpdateFailedError) {
      throw new AnswerRejectedError(reasonOf(error));
    }
    throw error;
  });
};

/** Options of {@link answerInbox}. */
export interface AnswerInboxOptions extends StepAnswer {
  address: string;
  namespace?: string;
  workflowId: string;
  /** Key that encrypts what goes through Temporal. */
  encryptionKey?: Uint8Array | undefined;
}

/**
 * Answers a wait step of a run, which a Worker of the run must serve.
 *
 * @throws {AnswerRejectedError} When the run rejects the answer, such as when the values do not
 *   match the declarations, or when the step or the visit no longer waits.
 */
export const answerInbox = async ({
  address,
  encryptionKey,
  namespace = "default",
  step,
  values,
  visit,
  workflowId,
}: AnswerInboxOptions): Promise<void> => {
  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace, ...clientDataConverter(encryptionKey) });
    await sendAnswer(client.workflow.getHandle(workflowId), { step, values, visit });
  } finally {
    await connection.close();
  }
};
