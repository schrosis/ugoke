import {
  conditionReferences,
  embedValue,
  evaluateExpression,
  parseCondition,
  pickReferences,
  resolveWorkflowInput,
  validateIntermediate,
} from "@ugoke/core";
import type {
  AiStep,
  IntermediateStep,
  ScriptStep,
  StepOutcome,
  WaitStep,
  WorkflowInput,
} from "@ugoke/core";
import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineUpdate,
  isCancellation,
  proxyActivities,
  proxyLocalActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

import type {
  Activities,
  AiStepResult,
  BranchedStepResult,
  ScriptStepRequest,
  StepOutput,
} from "../activities/index.js";
import { historyLimitMessage, jsonBytes, maxValueBytes } from "../limits.js";
import { answerUpdateName, waitingQueryName } from "../messages.js";
import type { Answer, WaitingStep } from "../messages.js";

const waitingQuery = defineQuery<WaitingStep | null>(waitingQueryName);

// Recording an event is quick, so a local activity keeps it out of the task queue.
const { chooseBranch, recordEvent } = proxyLocalActivities<Activities>({
  retry: { maximumAttempts: 3 },
  startToCloseTimeout: "10 seconds",
});
const answerUpdate = defineUpdate<void, [Answer]>(answerUpdateName);

/**
 * Extra time that lets a script runner report its own timeout before the activity times out.
 *
 * Keep it longer than the time a script runner needs to stop a script, such as `killGraceMs`
 * in `@ugoke/adapter-script-local`.
 */
const activityTimeoutGraceMs = 10_000;

/**
 * Time after which Temporal treats an activity without heartbeats as failed.
 *
 * Keep it longer than `heartbeatIntervalMs` of the activities.
 */
const activityHeartbeatTimeoutMs = 30_000;

/**
 * Returns the activities that run a step.
 *
 * They are not retried, because a step may have had side effects before it failed.
 */
const stepActivities = (timeoutMs: number) =>
  proxyActivities<Activities>({
    heartbeatTimeout: activityHeartbeatTimeoutMs,
    retry: { maximumAttempts: 1 },
    startToCloseTimeout: timeoutMs + activityTimeoutGraceMs,
  });

/**
 * The activity that answers a wait step with a method that answers in the Worker.
 *
 * A wait has no timeout, so the activity may run as long as the run waits. A Worker that stops,
 * such as when the resident process restarts, misses heartbeats, and another attempt asks
 * again. A method that fails does not retry, because the activity fails it as non-retryable.
 * A cancelled wait ends after its method stopped asking, so that no one answers a closed step.
 */
const { respondToWait } = proxyActivities<Activities>({
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  heartbeatTimeout: activityHeartbeatTimeoutMs,
  retry: { initialInterval: "1 second", maximumInterval: "1 minute" },
  startToCloseTimeout: "3650 days",
});

/** Result of {@link ugoke}. */
export interface WorkflowResult {
  /** IDs of the executed steps, in execution order. */
  executedSteps: string[];
}

/** Values that every field of a step can reference: earlier outputs and the workflow input. */
type SharedContext = Readonly<{
  steps: Readonly<
    Record<string, { outputs: StepOutput; visits: readonly { outputs: StepOutput }[] }>
  >;
  workflow: Readonly<{ inputs: Readonly<WorkflowInput> }>;
}>;

/** Top-level names of {@link SharedContext}. */
const sharedRoots: ReadonlySet<string> = new Set(["steps", "workflow"]);

/** Evaluates the input values of a step. */
const evaluateInput = (
  id: string,
  expressions: Readonly<Record<string, string>>,
  context: SharedContext,
): Record<string, unknown> => {
  const inputs: Record<string, unknown> = {};
  for (const [name, expression] of Object.entries(expressions)) {
    const evaluated = evaluateExpression(expression, context);
    if (!evaluated.ok) {
      throw ApplicationFailure.nonRetryable(
        `steps.${id}.inputs.${name}: ${evaluated.message}`,
        "InvalidExpression",
      );
    }
    inputs[name] = evaluated.value;
  }

  return inputs;
};

/** Checks the size of the values that a step receives. */
const checkValueSize = (id: string, values: unknown): void => {
  const bytes = jsonBytes(values);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `The values for steps.${id} are ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "InputTooLarge",
    );
  }
};

/** Returns the references of the conditions of a step. */
const conditionPaths = (step: IntermediateStep): string[][] => {
  if (step.next.type !== "branch") {
    return [];
  }
  return step.next.branches.flatMap(({ if: text }) => {
    const parsed = text === undefined ? undefined : parseCondition(text);
    return parsed?.ok === true ? conditionReferences(parsed.condition) : [];
  });
};

/**
 * Builds the values that a step receives and checks their size.
 *
 * The step receives only the shared values that it references, so that the
 * history does not store every value of the workflow again for each step.
 */
const prepareStep = (
  id: string,
  step: AiStep | ScriptStep,
  context: SharedContext,
  workflowEnv: Readonly<Record<string, string>>,
) => {
  const inputs = evaluateInput(id, step.inputs, context);
  const references = pickReferences(
    [
      step.type === "script" ? step.run : step.prompt,
      ...Object.values(step.outputs),
      ...Object.values(step.env ?? {}),
    ],
    context,
    sharedRoots,
    conditionPaths(step),
  );

  // The values can combine the output of several steps, so they are limited separately.
  checkValueSize(id, { inputs, references, workflowEnv });
  return { inputs, references };
};

const invalidExpression = (location: string, message: string): ApplicationFailure =>
  ApplicationFailure.nonRetryable(`${location}: ${message}`, "InvalidExpression");

/** Evaluates every string in a JSON value, such as the options in `with`. */
const evaluateStrings = (
  value: unknown,
  location: string,
  context: Readonly<Record<string, unknown>>,
): unknown => {
  if (typeof value === "string") {
    const evaluated = evaluateExpression(value, context);
    if (!evaluated.ok) {
      throw invalidExpression(location, evaluated.message);
    }
    return evaluated.value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => evaluateStrings(item, `${location}[${index}]`, context));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        evaluateStrings(item, `${location}.${key}`, context),
      ]),
    );
  }
  return value;
};

/**
 * Returns the message of the innermost cause of an error, such as the failure of a method
 * inside the failure of its activity.
 */
const innermostMessage = (error: unknown): string => {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
};

/** Evaluates the outputs of a wait step from the answers that it received. */
const evaluateWaitOutputs = (
  id: string,
  step: WaitStep,
  context: Readonly<Record<string, unknown>>,
): StepOutput => {
  const output: StepOutput = {};
  for (const [name, expression] of Object.entries(step.outputs)) {
    const evaluated = evaluateExpression(expression, context);
    if (!evaluated.ok) {
      throw invalidExpression(`steps.${id}.outputs.${name}`, evaluated.message);
    }
    output[name] = evaluated.value;
  }
  const bytes = jsonBytes(output);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `steps.${id}.outputs is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "OutputTooLarge",
    );
  }
  return output;
};

/**
 * Executes a workflow in the intermediate representation.
 *
 * The export name is the workflow type that Temporal shows. Renaming it prevents Workers from
 * continuing runs that started with the previous name.
 *
 * Both arguments are validated again because they can be supplied without the CLI, such as
 * from the Temporal Web UI.
 *
 * @param intermediate The workflow in the intermediate representation.
 * @param inputs Values of the workflow input, keyed by name. Defaults are applied here.
 */
export const ugoke = async (
  intermediate: unknown,
  inputs: unknown = {},
): Promise<WorkflowResult> => {
  const validation = validateIntermediate(intermediate);
  if (!validation.ok) {
    throw ApplicationFailure.nonRetryable(
      "Invalid intermediate representation",
      "InvalidIntermediate",
      validation.errors,
    );
  }

  const resolved = resolveWorkflowInput(validation.intermediate.inputs, inputs);
  if (!resolved.ok) {
    throw ApplicationFailure.nonRetryable(
      resolved.errors
        .map(({ message, path }) => `${["workflow.inputs", ...path].join(".")}: ${message}`)
        .join("\n"),
      "InvalidInput",
      resolved.errors,
    );
  }
  const bytes = jsonBytes(resolved.inputs);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `workflow.inputs is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "InputTooLarge",
    );
  }

  // The wait step that waits for an answer, and the answer that it received.
  let waiting: WaitingStep | null = null;
  let answer: WorkflowInput | undefined;
  setHandler(waitingQuery, () => waiting);
  setHandler(
    answerUpdate,
    ({ values }) => {
      // The validator below has accepted these values, so the resolution succeeds.
      const accepted = waiting === null ? undefined : resolveWorkflowInput(waiting.answers, values);
      if (accepted?.ok === true) {
        answer = accepted.inputs;
        waiting = null;
      }
    },
    {
      // A rejected answer leaves no trace in the history, and the caller can answer again.
      validator: ({ runId, step, values, visit, workflowId }) => {
        // An answer copied from the history of another run names that run. The server assigns
        // the run ID, so a run that is started again with the same workflow ID has another.
        const info = workflowInfo();
        if (workflowId !== info.workflowId || runId !== info.runId) {
          throw new Error("The answer is not for this run");
        }
        const current = waiting;
        if (current === null || current.step !== step || current.visit !== visit) {
          throw new Error(`Step ${step} is not waiting for an answer`);
        }
        // The definition says where the step is answered, so no other process can answer it.
        if (current.respondIn === "worker") {
          throw new Error(`Step ${step} is answered by its wait method ${current.method}`);
        }
        const accepted = resolveWorkflowInput(current.answers, values);
        if (!accepted.ok) {
          throw new Error(
            accepted.errors
              .map(({ message, path }) => `${[step, ...path].join(".")}: ${message}`)
              .join("\n"),
          );
        }
        const answerBytes = jsonBytes(accepted.inputs);
        if (answerBytes > maxValueBytes) {
          throw new Error(
            `The answer is ${answerBytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
          );
        }
      },
    },
  );

  /**
   * Answers a wait step with a method that answers in the Worker, and validates the answer.
   *
   * @returns The answers, with defaults applied.
   */
  const answerInWorker = async (
    step: string,
    visit: number,
    method: string,
    answers: NonNullable<WaitStep["answers"]>,
    options: Readonly<Record<string, unknown>>,
    startedAt: number,
  ): Promise<WorkflowInput> => {
    const run = { inputs: resolved.inputs, workflowId: workflowInfo().workflowId };
    checkValueSize(step, { options, run });
    const values = await respondToWait({
      answers,
      method,
      options,
      run,
      startedAt: new Date(startedAt).toISOString(),
      step,
      visit,
    });
    const accepted = resolveWorkflowInput(answers, values);
    if (!accepted.ok) {
      throw ApplicationFailure.nonRetryable(
        accepted.errors
          .map(({ message, path }) => `${[`steps.${step}`, ...path].join(".")}: ${message}`)
          .join("\n"),
        "InvalidAnswer",
      );
    }
    const answerBytes = jsonBytes(accepted.inputs);
    if (answerBytes > maxValueBytes) {
      throw ApplicationFailure.nonRetryable(
        `steps.${step}: The answer is ${answerBytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
        "AnswerTooLarge",
      );
    }
    return accepted.inputs;
  };

  const { dotenv, start, steps } = validation.intermediate;
  // Sessions of the AI steps of this run, keyed by step, so that each step continues its own.
  const sessions: Record<string, string> = {};
  // The environment of the workflow reads only its input, so it is the same for every step.
  const workflowEnv: Record<string, string> = {};
  for (const [name, expression] of Object.entries(validation.intermediate.env ?? {})) {
    const evaluated = evaluateExpression(expression, { workflow: { inputs: resolved.inputs } });
    if (!evaluated.ok) {
      throw invalidExpression(`env.${name}`, evaluated.message);
    }
    workflowEnv[name] = embedValue(evaluated.value);
  }
  const executedSteps: string[] = [];
  // The latest output of each step.
  const outputs: Record<string, StepOutput> = {};
  // The outputs of every visit of each step, oldest first (B10b).
  const visits: Record<string, { outputs: StepOutput }[]> = {};

  let id: string | null = start;
  while (id !== null) {
    const step: IntermediateStep | undefined = steps[id];
    if (step === undefined) {
      throw ApplicationFailure.nonRetryable(`Unknown step: ${id}`, "InvalidIntermediate");
    }
    const context: SharedContext = {
      steps: Object.fromEntries(
        Object.entries(outputs).map(([stepId, output]) => [
          stepId,
          { outputs: output, visits: visits[stepId] ?? [] },
        ]),
      ),
      workflow: { inputs: resolved.inputs },
    };

    const visited = visits[id]?.length ?? 0;
    if (step.maxVisits !== undefined && visited >= step.maxVisits) {
      throw ApplicationFailure.nonRetryable(
        `steps.${id}: The step already ran ${visited} times, which is its maxVisits`,
        "MaxVisitsExceeded",
      );
    }
    // Temporal terminates a run at its limits, and the step would not be told why.
    const info = workflowInfo();
    const historyLimit = historyLimitMessage(info.historyLength, info.historySize);
    if (historyLimit !== undefined) {
      throw ApplicationFailure.nonRetryable(`steps.${id}: ${historyLimit}`, "HistoryTooLong");
    }

    // Where a step with branches goes, which its activity tells.
    let chosen: string | null = null;

    if (step.type === "ai") {
      const { executeAiStep } = stepActivities(step.timeoutMs);
      const prepared = prepareStep(id, step, context, workflowEnv);
      const evaluated = evaluateStrings(step.with, `steps.${id}.with`, {
        ...context,
        inputs: prepared.inputs,
      });
      const options = typeof evaluated === "object" && evaluated !== null ? { ...evaluated } : {};
      checkValueSize(id, { ...prepared, options, workflowEnv });
      const result: AiStepResult = await executeAiStep({
        ...prepared,
        ...(step.continueOnError === true ? { continueOnError: true } : {}),
        ...(step.next.type === "branch" ? { branches: step.next.branches } : {}),
        dotenv,
        model: step.model,
        options,
        outputs: step.outputs,
        prompt: step.prompt,
        provider: step.provider,
        schema: step.schema,
        sessionId: step.session === "reuse" ? sessions[id] : undefined,
        step: id,
        stepEnv: step.env,
        timeoutMs: step.timeoutMs,
        workflowEnv,
      });
      outputs[id] = result.outputs;
      chosen = result.next ?? null;
      if (result.sessionId !== undefined) {
        sessions[id] = result.sessionId;
      }
    } else if (step.type === "wait") {
      if (step.answers === undefined) {
        throw ApplicationFailure.nonRetryable(
          `steps.${id}: Wait method ${step.method} does not describe its answers, which is not supported yet`,
          "UnsupportedStep",
        );
      }
      const stepInputs = evaluateInput(id, step.inputs, context);
      const options = evaluateStrings(step.with, `steps.${id}.with`, {
        ...context,
        inputs: stepInputs,
      });
      // The start is stored before the step can be answered, so that it is shown first.
      const waitMessage =
        typeof options === "object" &&
        options !== null &&
        "message" in options &&
        typeof options.message === "string"
          ? options.message
          : undefined;
      await recordEvent({ message: waitMessage, step: id, type: "stepStarted" });
      // Workflow time is deterministic, so the duration is the same when the history replays.
      const startedAt = Date.now();
      const waitingStep = id;
      const finish = async (outcome: StepOutcome, message?: string): Promise<void> =>
        recordEvent({
          durationMs: Date.now() - startedAt,
          message,
          outcome,
          step: waitingStep,
          type: "stepFinished",
        });
      const waitOptions = typeof options === "object" && options !== null ? { ...options } : {};
      waiting = {
        answers: step.answers,
        method: step.method,
        options: waitOptions,
        ...(step.respondIn === undefined ? {} : { respondIn: step.respondIn }),
        startedAt: new Date(startedAt).toISOString(),
        step: id,
        visit: visited,
        workflowInputs: resolved.inputs,
      };
      answer = undefined;
      try {
        // Cancelling the workflow interrupts the wait.
        const received =
          step.respondIn === "worker"
            ? await answerInWorker(id, visited, step.method, step.answers, waitOptions, startedAt)
            : await condition(() => answer !== undefined).then(() => answer);
        // The update clears it for an answer that comes from outside the Worker.
        waiting = null;
        outputs[id] = evaluateWaitOutputs(id, step, {
          ...context,
          inputs: stepInputs,
          result: received,
        });
        if (step.next.type === "branch") {
          const values: Record<string, unknown> = {
            ...pickReferences([], context, sharedRoots, conditionPaths(step)),
            outputs: outputs[id],
            result: received,
          };
          checkValueSize(id, { values, workflowEnv });
          chosen = await chooseBranch({
            branches: step.next.branches,
            dotenv,
            values,
            workflowEnv,
          });
        }
      } catch (error) {
        waiting = null;
        // It also tells an activity that was cancelled with the run, such as of a wait method.
        if (isCancellation(error)) {
          await CancellationScope.nonCancellable(async () => finish("cancelled"));
        } else {
          await finish("failed", innermostMessage(error));
        }
        throw error;
      }
      await finish("succeeded");
    } else {
      const { executeBranchingScriptStep, executeScriptStep } = stepActivities(step.timeoutMs);
      const request: ScriptStepRequest = {
        ...prepareStep(id, step, context, workflowEnv),
        ...(step.continueOnError === true ? { continueOnError: true } : {}),
        dotenv,
        outputs: step.outputs,
        run: step.run,
        step: id,
        stepEnv: step.env,
        timeoutMs: step.timeoutMs,
        workflowEnv,
      };
      // A step without branches keeps the result of the activity that recorded histories have.
      if (step.next.type === "branch") {
        const result: BranchedStepResult = await executeBranchingScriptStep({
          ...request,
          branches: step.next.branches,
        });
        outputs[id] = result.outputs;
        chosen = result.next;
      } else {
        outputs[id] = await executeScriptStep(request);
      }
    }
    executedSteps.push(id);
    visits[id] = [...(visits[id] ?? []), { outputs: outputs[id] ?? {} }];

    id = step.next.type === "branch" ? chosen : step.next.type === "step" ? step.next.step : null;
  }

  // Outputs are not returned, because the result of every step together could exceed the
  // payload limit of Temporal.
  return { executedSteps };
};
