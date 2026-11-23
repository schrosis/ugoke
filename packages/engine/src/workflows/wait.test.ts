import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createPluginRegistry, definePlugin, intermediateVersion } from "@ugoke/core";
import type { Intermediate, ScriptRequest, WaitResponseContext } from "@ugoke/core";
import { WorkflowUpdateFailedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { createActivities } from "../activities/index.ts";
import { answerUpdateName, waitingQueryName } from "../messages.ts";
import type { WaitingStep } from "../messages.ts";
import { ugoke } from "./index.ts";

const intermediate: Intermediate = {
  inputs: { greeting: { default: "Hello", required: false, type: "string" } },
  start: "ask",
  steps: {
    ask: {
      answers: {
        approve: { required: false, type: "boolean" },
        name: { required: true, type: "string" },
      },
      inputs: { prefix: "${{ workflow.inputs.greeting }}" },
      method: "terminal",
      next: { step: "greet", type: "step" },
      outputs: {
        approve: "${{ result.approve }}",
        label: "${{ inputs.prefix }} ${{ result.name }}",
      },
      type: "wait",
      with: {
        message: "${{ inputs.prefix }}, who are you?",
        tags: ["${{ workflow.inputs.greeting }}"],
      },
    },
    greet: {
      inputs: {},
      next: { type: "end" },
      outputs: {},
      run: 'echo "${{ steps.ask.outputs.label }} ${{ steps.ask.outputs.approve }}"',
      timeoutMs: 5000,
      type: "script",
    },
  },
  version: intermediateVersion,
};

/** Waits until the workflow waits for an answer. */
const waitForStep = async (handle: WorkflowHandle): Promise<WaitingStep> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await handle.query<WaitingStep | null>(waitingQueryName);
    if (waiting !== null) {
      return waiting;
    }
    await sleep(50);
  }
  throw new Error("The workflow did not wait for an answer");
};

/** Sends an answer for the first visit of a step of the run, unless the value says otherwise. */
const answer = async (handle: WorkflowHandle, value: object) =>
  handle.executeUpdate(answerUpdateName, {
    args: [
      {
        runId: (await handle.describe()).runId,
        visit: 0,
        workflowId: handle.workflowId,
        ...value,
      },
    ],
  });

describe("ugoke wait steps", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const withWorkflow = async (
    test: (handle: WorkflowHandle, requests: ScriptRequest[]) => Promise<void>,
  ) => {
    const requests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        scriptRunner: {
          run: async (request) => {
            requests.push(request);
            return { exitCode: 0, signal: null, stderr: "", stdout: "" };
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(ugoke, {
        args: [intermediate],
        taskQueue,
        workflowId: randomUUID(),
      });
      await test(handle, requests);
    });
  };

  it("waits with the evaluated options and continues with the answers", async () => {
    await withWorkflow(async (handle, requests) => {
      await expect(waitForStep(handle)).resolves.toEqual({
        answers: intermediate.steps.ask?.type === "wait" ? intermediate.steps.ask.answers : {},
        method: "terminal",
        options: { message: "Hello, who are you?", tags: ["Hello"] },
        startedAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
        ) as unknown,
        step: "ask",
        visit: 0,
        workflowInputs: { greeting: "Hello" },
      });

      await answer(handle, { step: "ask", values: { name: "ugoke" } });

      await expect(handle.result()).resolves.toEqual({ executedSteps: ["ask", "greet"] });
      // The optional answer that was not given is null, and embeds as an empty string.
      expect(requests.map(({ run }) => run)).toEqual(['echo "Hello ugoke "']);
      await expect(handle.query(waitingQueryName)).resolves.toBeNull();
    });
  }, 60_000);

  it.each([
    [{ step: "ask", values: {} }, "ask.name: Required"],
    [{ step: "ask", values: { name: 1 } }, "ask.name: Must be a string"],
    [{ step: "greet", values: { name: "ugoke" } }, "Step greet is not waiting for an answer"],
    [{ step: "ask", values: { name: "ugoke" }, visit: 1 }, "Step ask is not waiting for an answer"],
    [
      { step: "ask", values: { name: "ugoke" }, visit: undefined },
      "Step ask is not waiting for an answer",
    ],
    [
      { step: "ask", values: { name: "ugoke" }, workflowId: "another-run" },
      "The answer is not for this run",
    ],
    [
      { step: "ask", values: { name: "ugoke" }, workflowId: undefined },
      "The answer is not for this run",
    ],
    [
      { runId: "another-run", step: "ask", values: { name: "ugoke" } },
      "The answer is not for this run",
    ],
    [
      { runId: undefined, step: "ask", values: { name: "ugoke" } },
      "The answer is not for this run",
    ],
  ])(
    "rejects the answer %j and keeps waiting",
    async (value, message) => {
      await withWorkflow(async (handle) => {
        await waitForStep(handle);

        const rejected = await answer(handle, value).catch((error: unknown) => error);
        expect(rejected).toBeInstanceOf(WorkflowUpdateFailedError);
        expect(rejected).toMatchObject({ cause: { message } });

        await expect(waitForStep(handle)).resolves.toMatchObject({ step: "ask" });
        await handle.terminate();
      });
    },
    60_000,
  );

  it("stops waiting when the workflow is cancelled", async () => {
    await withWorkflow(async (handle, requests) => {
      await waitForStep(handle);
      await handle.cancel();

      await expect(handle.result()).rejects.toMatchObject({ cause: { name: "CancelledFailure" } });
      expect(requests).toEqual([]);
    });
  }, 60_000);
});

describe("ugoke wait steps that the Worker answers", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const answeredInWorker: Intermediate = {
    ...intermediate,
    steps: {
      ...intermediate.steps,
      ask: {
        answers: { name: { required: true, type: "string" } },
        inputs: {},
        method: "chat",
        next: { step: "greet", type: "step" },
        outputs: { label: "${{ result.name }}" },
        respondIn: "worker",
        type: "wait",
        with: { message: "${{ workflow.inputs.greeting }}, who are you?" },
      },
      greet: {
        inputs: {},
        next: { type: "end" },
        outputs: {},
        run: 'echo "${{ steps.ask.outputs.label }}"',
        timeoutMs: 5000,
        type: "script",
      },
    },
  };

  const withWorkflow = async (
    respond: (context: WaitResponseContext<unknown>) => Promise<Record<string, unknown>>,
    test: (handle: WorkflowHandle, requests: ScriptRequest[]) => Promise<void>,
  ) => {
    const requests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        heartbeatIntervalMs: 100,
        plugins: createPluginRegistry({
          builtins: [
            definePlugin({
              name: "test",
              waitMethods: [
                {
                  name: "chat",
                  respond,
                  respondIn: "worker",
                  with: z.strictObject({ message: z.string() }),
                },
              ],
            }),
          ],
        }),
        scriptRunner: {
          run: async (request) => {
            requests.push(request);
            return { exitCode: 0, signal: null, stderr: "", stdout: "" };
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(ugoke, {
        args: [answeredInWorker],
        taskQueue,
        workflowId: randomUUID(),
      });
      await test(handle, requests);
    });
  };

  it("answers with the method in the Worker and continues with the answers", async () => {
    const contexts: Omit<WaitResponseContext<unknown>, "signal">[] = [];

    await withWorkflow(
      async ({ signal: _signal, ...context }) => {
        contexts.push(context);
        return { name: "ugoke" };
      },
      async (handle, requests) => {
        await expect(handle.result()).resolves.toEqual({ executedSteps: ["ask", "greet"] });
        expect(contexts).toEqual([
          {
            answers: { name: { required: true, type: "string" } },
            config: undefined,
            log: expect.any(Function) as unknown,
            options: { message: "Hello, who are you?" },
            run: { inputs: { greeting: "Hello" }, workflowId: handle.workflowId },
            startedAt: expect.any(Date) as unknown,
            step: "ask",
            visit: 0,
          },
        ]);
        // The step starts to wait in workflow time, after the run starts and before it ends.
        const { closeTime, startTime } = await handle.describe();
        const startedAt = contexts[0]?.startedAt.getTime();
        expect(startedAt).toBeGreaterThanOrEqual(startTime.getTime());
        expect(startedAt).toBeLessThanOrEqual(closeTime?.getTime() ?? Number.NaN);
        expect(requests.map(({ run }) => run)).toEqual(['echo "ugoke"']);
      },
    );
  }, 60_000);

  it("accepts no answers from outside the method", async () => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();

    await withWorkflow(
      async () => {
        await released;
        return { name: "ugoke" };
      },
      async (handle) => {
        await expect(waitForStep(handle)).resolves.toMatchObject({
          method: "chat",
          respondIn: "worker",
          step: "ask",
        });

        const rejected = await answer(handle, { step: "ask", values: { name: "other" } }).catch(
          (error: unknown) => error,
        );
        expect(rejected).toMatchObject({
          cause: { message: "Step ask is answered by its wait method chat" },
        });

        release();
        await expect(handle.result()).resolves.toEqual({ executedSteps: ["ask", "greet"] });
      },
    );
  }, 60_000);

  it("stops the method when the workflow is cancelled", async () => {
    const { promise: waiting, resolve: started } = Promise.withResolvers<void>();
    let stopped: unknown;

    await withWorkflow(
      async ({ signal }) => {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            stopped = signal.reason;
            reject(new Error("stopped"));
          });
        });
      },
      async (handle, requests) => {
        await waiting;
        await handle.cancel();

        await expect(handle.result()).rejects.toMatchObject({
          cause: { name: "CancelledFailure" },
        });
        expect(stopped).toBeDefined();
        expect(requests).toEqual([]);
      },
    );
  }, 60_000);

  it("asks again in the next Worker after the Worker stopped", async () => {
    const taskQueue = randomUUID();
    const createWorker = async (
      respond: (context: WaitResponseContext<unknown>) => Promise<Record<string, unknown>>,
      stopping?: AbortSignal,
    ) =>
      Worker.create({
        activities: createActivities({
          heartbeatIntervalMs: 100,
          plugins: createPluginRegistry({
            builtins: [
              definePlugin({
                name: "test",
                waitMethods: [
                  {
                    name: "chat",
                    respond,
                    respondIn: "worker",
                    with: z.strictObject({ message: z.string() }),
                  },
                ],
              }),
            ],
          }),
          scriptRunner: {
            run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }),
          },
          stopping,
        }),
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
      });
    const stopping = new AbortController();
    const { promise: asked, resolve: ask } = Promise.withResolvers<void>();
    const startedAt: Date[] = [];
    const first = await createWorker(async ({ signal, startedAt: started }) => {
      startedAt.push(started);
      ask();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("stopped")));
      });
    }, stopping.signal);

    const handle = await first.runUntil(async () => {
      const started = await environment.client.workflow.start(ugoke, {
        args: [answeredInWorker],
        taskQueue,
        workflowId: randomUUID(),
      });
      await asked;
      // The Worker stops after its waits end, as a resident process does.
      stopping.abort();
      return started;
    });
    // Time passes before the next Worker asks, as it does while the resident process restarts.
    await environment.sleep(1000);
    const second = await createWorker(async ({ startedAt: started }) => {
      startedAt.push(started);
      return { name: "again" };
    });

    await expect(second.runUntil(handle.result())).resolves.toEqual({
      executedSteps: ["ask", "greet"],
    });
    // The next attempt receives when the step started to wait, not when it asked again.
    expect(startedAt).toHaveLength(2);
    expect(startedAt[0]).toBeInstanceOf(Date);
    expect(startedAt[1]).toEqual(startedAt[0]);
  }, 60_000);

  it.each([
    [
      async (): Promise<Record<string, unknown>> => {
        throw new Error("no one is here");
      },
      // The activity fails, and the failure of the method is its cause.
      { cause: { cause: { message: "steps.ask: Wait method chat failed: no one is here" } } },
    ],
    [async () => ({ name: 1 }), { cause: { message: "steps.ask.name: Must be a string" } }],
  ])(
    "fails the step when the method cannot answer (%#)",
    async (respond, failure) => {
      await withWorkflow(respond, async (handle, requests) => {
        await expect(handle.result()).rejects.toMatchObject(failure);
        expect(requests).toEqual([]);
      });
    },
    60_000,
  );
});
