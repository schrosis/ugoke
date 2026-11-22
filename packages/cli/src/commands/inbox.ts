import { realpath } from "node:fs/promises";

import type { InputDeclaration } from "@ugoke/core";
import {
  AnswerRejectedError,
  answerInbox,
  attachWorkflow,
  listInbox,
  sendAnswer,
} from "@ugoke/engine";
import type { InboxQuestion } from "@ugoke/engine";

import { reportAiFailure, writeAiLine } from "../ai.js";
import { openCommandServer } from "../daemon/connect.js";
import { loadEncryptionKey } from "../encryption.js";
import { followRun, rootMessage } from "../follow.js";
import { readWorkflowInput } from "../input.js";
import { acquireRunLock, RunLockedError } from "../lock.js";
import { formatAge, listProjectRuns } from "../runs.js";
import type { OpenedServer, ServerOptions } from "../server.js";
import { projectHash, projectLockDirectory, projectMemoKey, workflowMemoKey } from "../state.js";
import { ugokeDirectory, findProjectRoot } from "../workflows.js";
import type { CommandContext } from "./load.js";

/** Options of {@link listInboxCommand}. */
export interface InboxOptions {
  /**
   * Temporal Server that keeps the runs. Without it, the server of the project or of the
   * resident process is used.
   */
  server?: ServerOptions | undefined;
  /** Version of this ugoke, which the resident process must have to serve the project. */
  version: string;
  /** Writes JSON lines for a program such as an AI agent. */
  fromAi?: boolean | undefined;
}

/** Options of {@link answerInboxCommand}. */
export interface AnswerOptions extends InboxOptions {
  workflowId: string;
  step: string;
  /** Visit of the step, which keeps an answer from answering a later visit of a loop. */
  visit?: number | undefined;
  /** Value of `--values`: a JSON object, or the path of a `.json` file. */
  values: string;
  /** Aborted when the user interrupts, which detaches the run that the command follows. */
  signal: AbortSignal;
  /**
   * With `fromAi`, follows the run after the answer until its next question or its end, with a
   * Worker of this process unless the resident process runs it. Otherwise, exits after the
   * answer, and leaves the run to the resident process.
   */
  fromAi?: boolean | undefined;
  /** Called before the command runs a Worker. */
  prepareEngine?: (() => void) | undefined;
}

const findRoot = async (context: CommandContext): Promise<string | undefined> => {
  const found = await findProjectRoot(context.cwd);
  if (found === undefined) {
    context.stderr(`No ${ugokeDirectory} directory found in ${context.cwd} or its parents\n`);
    return undefined;
  }
  return realpath(found);
};

/** Describes a declaration of an answer, such as `decision: OK or 差し戻し (required)`. */
const describeAnswer = (name: string, declaration: InputDeclaration): string => {
  const kind =
    declaration.type === "choice"
      ? `one of ${declaration.options.join(", ")}`
      : declaration.type === "string" && declaration.multiline === true
        ? "multiline string"
        : declaration.type;
  const notes = [
    ...(declaration.required ? ["required"] : []),
    ...(declaration.default === undefined
      ? []
      : [`default ${JSON.stringify(declaration.default)}`]),
  ];
  const description = declaration.description === undefined ? "" : ` - ${declaration.description}`;
  return `${name}: ${kind}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}${description}`;
};

/** Where the questions of a project are answered. */
export interface AnswerTarget {
  /** Task queue that the resident process serves for the project, when it serves it. */
  servedTaskQueue?: string | undefined;
  /** Options that reach the same Temporal Server again, such as ` --address <address>`. */
  serverOptions: string;
}

/**
 * Formats a question with the command that answers it.
 *
 * `ugoke inbox answer` answers only a run that the resident process runs, so another run is
 * answered with `ugoke attach`, which follows it.
 */
export const formatQuestion = (
  question: InboxQuestion,
  { servedTaskQueue, serverOptions }: AnswerTarget,
): string => {
  const { answers, options, run, step, visit, workflowInputs } = question;
  const name = run.memo[workflowMemoKey];
  const header = [
    run.workflowId,
    typeof name === "string" ? name : undefined,
    `${step} (visit ${visit})`,
    `started ${formatAge(run.startTime)}`,
  ].filter((part) => part !== undefined);
  const lines = [header.join("  ")];
  if (workflowInputs !== undefined && Object.keys(workflowInputs).length > 0) {
    lines.push(`  inputs: ${JSON.stringify(workflowInputs)}`);
  }
  if (typeof options.message === "string") {
    lines.push(
      ...options.message
        .replace(/\n$/u, "")
        .split("\n")
        .map((line) => `  │ ${line}`),
    );
  }
  const entries = Object.entries(answers);
  lines.push(
    entries.length === 0
      ? "  answers: none"
      : `  answers:\n${entries.map(([key, declaration]) => `    ${describeAnswer(key, declaration)}`).join("\n")}`,
  );
  lines.push(
    run.taskQueue === servedTaskQueue
      ? `  ugoke inbox answer ${run.workflowId} --step ${step} --visit ${visit} --values '{...}' --detach${serverOptions}`
      : `  ugoke attach ${run.workflowId}${serverOptions}  (ugoke daemon does not run it)`,
  );
  return `${lines.join("\n")}\n`;
};

/**
 * Lists the wait steps of the runs of the project that wait for someone to answer them.
 *
 * @returns The exit code of the command.
 */
export const listInboxCommand = async (
  options: InboxOptions,
  context: CommandContext,
): Promise<number> =>
  options.fromAi === true
    ? reportAiFailure(context, async (watched) => listQuestions(options, watched))
    : listQuestions(options, context);

const listQuestions = async (options: InboxOptions, context: CommandContext): Promise<number> => {
  const root = await findRoot(context);
  if (root === undefined) {
    return 1;
  }
  try {
    const { server, servedTaskQueue } = await openCommandServer(options, root, context);
    const { questions, unreadable } = await listInbox({
      address: server.address,
      encryptionKey: loadEncryptionKey(),
      memo: { [projectMemoKey]: projectHash(root) },
    });
    if (options.fromAi === true) {
      for (const question of questions) {
        const { answers, options: methodOptions, run, step, visit, workflowInputs } = question;
        const name = run.memo[workflowMemoKey];
        writeAiLine(context.stdout, {
          answers,
          inDaemon: run.taskQueue === servedTaskQueue,
          inputs: workflowInputs,
          message: typeof methodOptions.message === "string" ? methodOptions.message : undefined,
          name: typeof name === "string" ? name : undefined,
          step,
          type: "question",
          visit,
          workflowId: run.workflowId,
        });
      }
      for (const { reason, run } of unreadable) {
        writeAiLine(context.stdout, { reason, type: "unreadable", workflowId: run.workflowId });
      }
      return unreadable.length === 0 ? 0 : 1;
    }
    for (const { reason, run } of unreadable) {
      context.stderr(
        `${run.workflowId}: cannot read what it waits for: ${reason}. Run "ugoke attach ${run.workflowId}${server.options}" to follow it\n`,
      );
    }
    if (questions.length === 0) {
      context.stdout("No questions in this project\n");
      return unreadable.length === 0 ? 0 : 1;
    }
    context.stdout(
      questions
        .map((question) =>
          formatQuestion(question, { servedTaskQueue, serverOptions: server.options }),
        )
        .join("\n"),
    );
    return unreadable.length === 0 ? 0 : 1;
  } catch (error) {
    context.stderr(`${rootMessage(error)}\n`);
    return 1;
  }
};

/**
 * Answers a wait step of a run of the project. With `fromAi`, follows the run until its next
 * question. Otherwise, leaves the run to the resident process.
 *
 * @returns The exit code of the command.
 */
export const answerInboxCommand = async (
  options: AnswerOptions,
  context: CommandContext,
): Promise<number> =>
  options.fromAi === true
    ? reportAiFailure(context, async (watched) => answerQuestion(options, watched))
    : answerQuestion(options, context);

const answerQuestion = async (options: AnswerOptions, context: CommandContext): Promise<number> => {
  const { step, values: valuesOption, visit, workflowId } = options;
  const root = await findRoot(context);
  if (root === undefined) {
    return 1;
  }
  const values = await readWorkflowInput(valuesOption, context.cwd, "--values");
  if (!values.ok) {
    context.stderr(`${values.message}\n`);
    return 1;
  }
  try {
    const { server, servedTaskQueue } = await openCommandServer(options, root, context);
    const run = (await listProjectRuns(server.address, root)).find(
      (candidate) => candidate.workflowId === workflowId,
    );
    if (run === undefined) {
      context.stderr(`No running run ${workflowId} in this project\n`);
      return 1;
    }
    if (options.fromAi === true) {
      return await answerAndFollow(
        { ...options, values: values.values },
        { name: run.name, root, server, servedTaskQueue, taskQueue: run.taskQueue },
        context,
      );
    }
    // The answer needs a Worker, and the run goes on after this command only in the resident
    // process.
    if (servedTaskQueue === undefined || run.taskQueue !== servedTaskQueue) {
      context.stderr(
        `${run.name}: ugoke daemon does not run ${workflowId}, so it would stop after the answer. Run "ugoke attach ${workflowId}${server.options}" to answer and follow it\n`,
      );
      return 1;
    }
    await answerInbox({
      address: server.address,
      encryptionKey: loadEncryptionKey(),
      step,
      values: values.values,
      visit,
      workflowId,
    });
    context.stdout(`${run.name}: answered ${step}. The run goes on in ugoke daemon\n`);
    return 0;
  } catch (error) {
    if (error instanceof AnswerRejectedError) {
      context.stderr(`${workflowId}: ${error.message}\n`);
      return 1;
    }
    context.stderr(`${rootMessage(error)}\n`);
    return 1;
  }
};

/**
 * Answers a run with a Worker that serves it, and follows it until its next question or its end.
 *
 * @returns The exit code of the command.
 */
const answerAndFollow = async (
  {
    prepareEngine,
    signal,
    step,
    values,
    visit,
    workflowId,
  }: Omit<AnswerOptions, "values"> & { values: Readonly<Record<string, unknown>> },
  {
    name,
    root,
    server,
    servedTaskQueue,
    taskQueue,
  }: {
    name: string;
    root: string;
    server: OpenedServer;
    servedTaskQueue: string | undefined;
    taskQueue: string;
  },
  context: CommandContext,
): Promise<number> => {
  let lock;
  try {
    lock = acquireRunLock(projectLockDirectory(root), workflowId);
  } catch (error) {
    if (error instanceof RunLockedError) {
      context.stderr(`${name}: ${error.message}\n`);
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
            // The answer needs a Worker, which serves the run from now on.
            beforeFollow: async (handle) => {
              await sendAnswer(handle, { step, values, visit });
              writeAiLine(context.stdout, { step, type: "answered", visit, workflowId });
            },
            servedTaskQueue,
            // The program saw the progress up to the question.
            skipEarlierEvents: true,
            workflowId,
          }),
        fromAi: true,
        interrupt: signal,
        name,
        ownsWorker: taskQueue !== servedTaskQueue,
        prepareEngine,
        root,
        server,
      },
      context,
    );
  } finally {
    lock.release();
  }
};
