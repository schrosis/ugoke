import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@ugoke/core";
import type { AiRequest, Intermediate, ScriptRequest, ScriptResult, ScriptStep } from "@ugoke/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createActivities } from "../activities/index.ts";
import type { ScriptStepRequest } from "../activities/index.ts";
import { answerUpdateName, waitingQueryName } from "../messages.ts";
import type { WaitingStep } from "../messages.ts";
import { ugoke } from "./index.ts";

const step = (run: string, next: string | null): Intermediate["steps"][string] => ({
  inputs: {},
  next: next === null ? { type: "end" } : { step: next, type: "step" },
  outputs: {},
  run,
  timeoutMs: 5000,
  type: "script",
});

const intermediate: Intermediate = {
  start: "fetch",
  steps: { fetch: step("./fetch.sh", "report"), report: step("./report.sh", null) },
  version: intermediateVersion,
  inputs: {},
};

/** Returns the output of a script. A list gives the outputs of each time it runs, in order. */
const nextStdout = (stdout: string | string[] | undefined): string =>
  Array.isArray(stdout) ? (stdout.shift() ?? "") : (stdout ?? "");

/** A loop that runs ./implement.sh and ./review.sh until the review prints something else. */
const reviewLoop = (implement: Partial<ScriptStep> = {}): Intermediate => ({
  ...intermediate,
  start: "implement",
  steps: {
    implement: {
      inputs: {},
      next: { step: "review", type: "step" },
      outputs: {},
      run: "./implement.sh",
      timeoutMs: 5000,
      type: "script",
      ...implement,
    },
    review: {
      ...step("./review.sh", null),
      next: {
        branches: [
          { if: "${{ outputs.note == 'changes' }}", to: { step: "implement", type: "step" } },
          { to: { type: "end" } },
        ],
        type: "branch",
      },
      outputs: { note: "${{ result.stdout }}" },
    },
  },
});

describe("ugoke", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const run = async (
    input: unknown,
    exitCodes: Record<string, number> = {},
    stdouts: Record<string, string | string[]> = {},
    workflowInput?: unknown,
  ) => {
    const requests: ScriptRequest[] = [];
    const stepRequests: ScriptStepRequest[] = [];
    const taskQueue = randomUUID();
    const activities = createActivities({
      scriptRunner: {
        run: async (request, { signal }): Promise<ScriptResult> => {
          expect(signal).toBeInstanceOf(AbortSignal);
          requests.push(request);
          return {
            exitCode: exitCodes[request.run] ?? 0,
            signal: null,
            stderr: "",
            stdout: nextStdout(stdouts[request.run]),
          };
        },
      },
    });
    const worker = await Worker.create({
      activities: {
        ...activities,
        // Records what the workflow sends, which the history stores.
        executeScriptStep: async (request: ScriptStepRequest) => {
          stepRequests.push(request);
          return activities.executeScriptStep(request);
        },
      },
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });

    const result = await worker.runUntil(
      environment.client.workflow
        .execute(ugoke, {
          args: workflowInput === undefined ? [input] : [input, workflowInput],
          taskQueue,
          workflowId: randomUUID(),
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ error, ok: false as const }),
        ),
    );
    return { requests, result, stepRequests };
  };

  it("passes the environment of the workflow and of the step", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        dotenv: ".env",
        env: { LEVEL: "${{ workflow.inputs.level }}" },
        inputs: { level: { default: "info", required: false, type: "string" } },
        steps: {
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: {
            ...step("./report.sh", null),
            env: { TITLE: "${{ steps.fetch.outputs.title }}" },
          },
        },
      },
      {},
      { "./fetch.sh": "hello\n" },
    );

    expect(result).toMatchObject({ ok: true });
    expect(requests.map(({ dotenv, env }) => ({ dotenv, env }))).toEqual([
      { dotenv: ".env", env: { LEVEL: "info" } },
      { dotenv: ".env", env: { LEVEL: "info", TITLE: "hello" } },
    ]);
  }, 60_000);

  it("runs an AI step and passes its result to later steps", async () => {
    const aiRequests: AiRequest[] = [];
    const scriptRequests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        aiRunner: {
          run: async (request) => {
            aiRequests.push(request);
            return { data: { verdict: "approve" }, sessionId: "s1" };
          },
        },
        scriptRunner: {
          run: async (request) => {
            scriptRequests.push(request);
            return { exitCode: 0, signal: null, stderr: "", stdout: "" };
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });
    const input: Intermediate = {
      ...intermediate,
      env: { LEVEL: "${{ workflow.inputs.level }}" },
      inputs: { level: { default: "info", required: false, type: "string" } },
      start: "review",
      steps: {
        report: { ...step("echo ${{ steps.review.outputs.verdict }}", null) },
        review: {
          inputs: {},
          model: "claude-opus-5-5",
          next: { step: "report", type: "step" },
          outputs: { verdict: "${{ result.data.verdict }}" },
          prompt: "Review for ${{ workflow.inputs.level }}",
          provider: "claude-code",
          schema: { type: "object" },
          session: "reuse",
          timeoutMs: 5000,
          type: "ai",
          with: { note: "${{ workflow.inputs.level }}" },
        },
      },
    };

    await worker.runUntil(
      environment.client.workflow.execute(ugoke, {
        args: [input],
        taskQueue,
        workflowId: randomUUID(),
      }),
    );

    expect(aiRequests).toEqual([
      {
        env: { LEVEL: "info" },
        model: "claude-opus-5-5",
        options: { note: "info" },
        prompt: "Review for info",
        provider: "claude-code",
        schema: { type: "object" },
        timeoutMs: 5000,
      },
    ]);
    expect(scriptRequests.map(({ run: command }) => command)).toEqual(["echo approve"]);
  }, 60_000);

  it.each([
    ["yes", ["./check.sh", "./then.sh", "./join.sh"]],
    ["no", ["./check.sh", "./else.sh", "./join.sh"]],
  ])(
    "follows the branch for %s and joins again",
    async (stdout, expected) => {
      const { requests, result } = await run(
        {
          ...intermediate,
          start: "check",
          steps: {
            check: {
              ...step("./check.sh", null),
              next: {
                branches: [
                  { if: "${{ result.stdout == 'yes' }}", to: { step: "matched", type: "step" } },
                  { to: { step: "other", type: "step" } },
                ],
                type: "branch",
              },
            },
            other: step("./else.sh", "join"),
            join: step("./join.sh", null),
            matched: step("./then.sh", "join"),
          },
        },
        {},
        { "./check.sh": `${stdout}\n` },
      );

      expect(result).toMatchObject({ ok: true });
      expect(requests.map(({ run: command }) => command)).toEqual(expected);
    },
    60_000,
  );

  it("goes back to an earlier step until a branch leaves the loop", async () => {
    const { requests, result } = await run(
      reviewLoop({
        run: "./implement.sh [${{ steps.review.outputs.note }}][${{ steps.review.visits[0].outputs.note }}]",
      }),
      {},
      { "./review.sh": ["changes\n", "changes\n", "fine\n"] },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        executedSteps: ["implement", "review", "implement", "review", "implement", "review"],
      },
    });
    expect(requests.map(({ run: command }) => command)).toEqual([
      "./implement.sh [][]",
      "./review.sh",
      "./implement.sh [changes][changes]",
      "./review.sh",
      "./implement.sh [changes][changes]",
      "./review.sh",
    ]);
  }, 60_000);

  it("reads the outputs of each visit", async () => {
    const { requests, result } = await run(
      reviewLoop({
        run: "./implement.sh [${{ steps.review.visits[0].outputs.note }}][${{ steps.review.visits[1].outputs.note }}]",
      }),
      {},
      { "./review.sh": ["changes\n", "changes\n", "fine\n"] },
    );

    expect(result).toMatchObject({ ok: true });
    expect(requests.filter(({ run: command }) => command.startsWith("./implement"))).toMatchObject([
      { run: "./implement.sh [][]" },
      { run: "./implement.sh [changes][]" },
      { run: "./implement.sh [changes][changes]" },
    ]);
  }, 60_000);

  it("fails before a step runs more than its maxVisits", async () => {
    const { requests, result } = await run(
      reviewLoop({ maxVisits: 2 }),
      {},
      {
        "./review.sh": "changes\n",
      },
    );

    expect(result).toMatchObject({
      error: {
        cause: {
          message: "steps.implement: The step already ran 2 times, which is its maxVisits",
          type: "MaxVisitsExceeded",
        },
      },
      ok: false,
    });
    expect(requests.map(({ run: command }) => command)).toEqual([
      "./implement.sh",
      "./review.sh",
      "./implement.sh",
      "./review.sh",
    ]);
  }, 60_000);

  it.each([
    ["reuse", ["none", "session-review-1"]],
    ["new", ["none", "none"]],
  ] as const)(
    "uses sessions for session: %s, one for each step",
    async (session, resumed) => {
      const aiRequests: AiRequest[] = [];
      const taskQueue = randomUUID();
      let reviews = 0;
      const worker = await Worker.create({
        activities: createActivities({
          aiRunner: {
            run: async (request) => {
              aiRequests.push(request);
              if (request.prompt === "Review") {
                reviews += 1;
                return {
                  data: { again: reviews === 1 },
                  sessionId: `session-review-${reviews}`,
                };
              }
              return { data: "done", sessionId: "session-implement" };
            },
          },
          scriptRunner: {
            run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }),
          },
        }),
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
      });
      const ai = {
        inputs: {},
        outputs: {},
        provider: "claude-code",
        timeoutMs: 5000,
        type: "ai" as const,
        with: {},
      };
      const input: Intermediate = {
        ...intermediate,
        start: "implement",
        steps: {
          implement: {
            ...ai,
            next: { step: "review", type: "step" },
            prompt: "Implement",
            session: "new",
          },
          review: {
            ...ai,
            next: {
              branches: [
                { if: "${{ result.data.again == true }}", to: { step: "implement", type: "step" } },
                { to: { type: "end" } },
              ],
              type: "branch",
            },
            prompt: "Review",
            schema: { type: "object" },
            session,
          },
        },
      };

      await worker.runUntil(
        environment.client.workflow.execute(ugoke, {
          args: [input],
          taskQueue,
          workflowId: randomUUID(),
        }),
      );

      expect(
        aiRequests
          .filter(({ prompt }) => prompt === "Review")
          .map(({ sessionId }) => sessionId ?? "none"),
      ).toEqual(resumed);
      // The other step does not continue the session of the review.
      expect(
        aiRequests.filter(({ prompt }) => prompt === "Implement").map(({ sessionId }) => sessionId),
      ).toEqual([undefined, undefined]);
    },
    60_000,
  );

  it("reads a visit of an earlier step", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        steps: {
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: step(
            "echo [${{ steps.fetch.visits[0].outputs.title }}][${{ steps.fetch.visits[1].outputs.title }}]",
            null,
          ),
        },
      },
      {},
      { "./fetch.sh": "hello\n" },
    );

    expect(result).toMatchObject({ ok: true });
    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh", "echo [hello][]"]);
  }, 60_000);

  it("does not take an answer for an earlier visit of a wait step", async () => {
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        scriptRunner: {
          run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }),
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });
    const input: Intermediate = {
      ...intermediate,
      start: "ask",
      steps: {
        ask: {
          answers: { again: { required: true, type: "boolean" } },
          inputs: {},
          method: "terminal",
          next: {
            branches: [
              { if: "${{ result.again == true }}", to: { step: "ask", type: "step" } },
              { to: { type: "end" } },
            ],
            type: "branch",
          },
          outputs: {},
          type: "wait",
          with: { message: "Again?" },
        },
      },
    };

    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(ugoke, {
        args: [input],
        taskQueue,
        workflowId: randomUUID(),
      });
      const waitForVisit = async (visit: number): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const waiting = await handle.query<WaitingStep | null>(waitingQueryName);
          if (waiting?.visit === visit) {
            return;
          }
          await sleep(25);
        }
        throw new Error(`The step did not wait for visit ${visit}`);
      };
      const { runId } = await handle.describe();
      const answerStep = async (visit: number, again: boolean) =>
        handle.executeUpdate(answerUpdateName, {
          args: [{ runId, step: "ask", values: { again }, visit, workflowId: handle.workflowId }],
        });

      await waitForVisit(0);
      await answerStep(0, true);
      await waitForVisit(1);
      await expect(answerStep(0, false)).rejects.toThrow();
      await answerStep(1, false);

      await expect(handle.result()).resolves.toMatchObject({ executedSteps: ["ask", "ask"] });
    });
  }, 60_000);

  it("finishes on a branch to end", async () => {
    const { requests, result } = await run({
      ...intermediate,
      start: "check",
      steps: {
        check: {
          ...step("./check.sh", null),
          next: {
            branches: [
              { if: "${{ result.exitCode == 0 }}", to: { type: "end" } },
              { to: { step: "after", type: "step" } },
            ],
            type: "branch",
          },
        },
        after: step("./after.sh", null),
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests.map(({ run: command }) => command)).toEqual(["./check.sh"]);
  }, 60_000);

  it("runs the steps in order", async () => {
    const { requests, result } = await run(intermediate);

    expect(result).toEqual({
      ok: true,
      value: { executedSteps: ["fetch", "report"] },
    });
    expect(requests).toEqual([
      { inputs: {}, run: "./fetch.sh", timeoutMs: 5000 },
      { inputs: {}, run: "./report.sh", timeoutMs: 5000 },
    ]);
  }, 60_000);

  it("stops when a script fails", async () => {
    const { requests, result } = await run(intermediate, { "./fetch.sh": 1 });

    expect(result).toMatchObject({
      error: { cause: { cause: { type: "ScriptFailed" } } },
      ok: false,
    });
    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh"]);
  }, 60_000);

  it("goes on after a step that continues on errors fails", async () => {
    const { requests, result } = await run(
      {
        inputs: {},
        start: "check",
        steps: {
          check: {
            continueOnError: true,
            inputs: {},
            next: {
              branches: [
                { if: "${{ !result.ok }}", to: { step: "fix", type: "step" } },
                { to: { type: "end" } },
              ],
              type: "branch",
            },
            outputs: { error: "${{ result.error }}", log: "${{ result.stdout }}" },
            run: "./check.sh",
            timeoutMs: 5000,
            type: "script",
          },
          fix: {
            inputs: {},
            next: { type: "end" },
            outputs: {},
            run: "./fix.sh '${{ steps.check.outputs.error }}' '${{ steps.check.outputs.log }}'",
            timeoutMs: 5000,
            type: "script",
          },
        },
        version: intermediateVersion,
      },
      { "./check.sh": 1 },
      { "./check.sh": "2 tests failed\n" },
    );

    expect(result).toMatchObject({ ok: true, value: { executedSteps: ["check", "fix"] } });
    expect(requests.map(({ run: command }) => command)).toEqual([
      "./check.sh",
      "./fix.sh 'Script exited with code 1' '2 tests failed'",
    ]);
  }, 60_000);

  it("stops a running script when the workflow is cancelled", async () => {
    const taskQueue = randomUUID();
    let started!: () => void;
    const startedScript = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const abortedScript = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const worker = await Worker.create({
      activities: createActivities({
        heartbeatIntervalMs: 100,
        scriptRunner: {
          run: async (_request, { signal }): Promise<ScriptResult> =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                aborted();
                reject(signal.reason);
              });
              started();
            }),
        },
      }),
      connection: environment.nativeConnection,
      defaultHeartbeatThrottleInterval: "100 milliseconds",
      maxHeartbeatThrottleInterval: "100 milliseconds",
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });

    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(ugoke, {
        args: [intermediate],
        taskQueue,
        workflowId: randomUUID(),
      });
      await startedScript;
      await handle.cancel();
      // Without heartbeats, the script would be stopped only by the 30 second heartbeat timeout.
      await Promise.race([
        abortedScript,
        sleep(10_000).then(() => {
          throw new Error("The script was not stopped by the cancellation");
        }),
      ]);
    });
  }, 60_000);

  it("passes output values to later steps", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        steps: {
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: {
            ...step('./report.sh "${{ inputs.title }}"', null),
            inputs: { title: "${{ steps.fetch.outputs.title }}" },
          },
        },
      },
      {},
      { "./fetch.sh": "hello\n" },
    );

    expect(result).toEqual({
      ok: true,
      value: { executedSteps: ["fetch", "report"] },
    });
    expect(requests.at(-1)).toEqual({
      inputs: { title: "hello" },
      run: './report.sh "hello"',
      timeoutMs: 5000,
    });
  }, 60_000);

  it("evaluates a function call in the inputs of a step", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        inputs: { title: { required: true, type: "string" } },
        steps: {
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: {
            ...step('./report.sh "${{ inputs.title }}" "${{ inputs.name }}"', null),
            inputs: {
              name: "${{ trim(workflow.inputs.title) }}",
              title: "[${{ trim(steps.fetch.outputs.title) }}]",
            },
          },
        },
      },
      {},
      { "./fetch.sh": "  hello \n\n" },
      { title: "\tugoke " },
    );

    expect(result).toEqual({ ok: true, value: { executedSteps: ["fetch", "report"] } });
    expect(requests.at(-1)).toEqual({
      inputs: { name: "ugoke", title: "[hello]" },
      run: './report.sh "[hello]" "ugoke"',
      timeoutMs: 5000,
    });
  }, 60_000);

  it("stops when a function in the inputs of a step gets a workflow input that is not given", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        inputs: { note: { required: false, type: "string" } },
        steps: {
          fetch: step("./fetch.sh", "report"),
          report: {
            ...step("./report.sh", null),
            inputs: { note: "${{ trim(workflow.inputs.note) }}" },
          },
        },
      },
      {},
      {},
      {},
    );

    expect(result).toMatchObject({
      error: {
        cause: {
          message:
            "steps.report.inputs.note: trim expects a string but got null: ${{ trim(workflow.inputs.note) }}",
          nonRetryable: true,
          type: "InvalidExpression",
        },
      },
      ok: false,
    });
    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh"]);
  }, 60_000);

  it("sends the outputs referenced in the argument of a function to a step", async () => {
    const { requests, stepRequests } = await run(
      {
        ...intermediate,
        steps: {
          fetch: {
            ...step("./fetch.sh", "report"),
            outputs: { title: "${{ result.stdout }}", unused: "${{ result.stderr }}" },
          },
          report: {
            ...step('./report.sh "${{ trim(steps.fetch.outputs.title) }}"', null),
            outputs: { title: "${{ trim(steps.fetch.outputs.title) }}" },
          },
        },
      },
      {},
      { "./fetch.sh": " hello \n" },
    );

    expect(stepRequests.at(-1)?.references).toEqual({
      steps: { fetch: { outputs: { title: " hello " } } },
    });
    expect(requests.at(-1)?.run).toBe('./report.sh "hello"');
  }, 60_000);

  it("fails when the combined input exceeds the size limit", async () => {
    const half = "x".repeat(300 * 1024);
    const { requests, result } = await run(
      {
        ...intermediate,
        start: "first",
        steps: {
          first: { ...step("./first.sh", "second"), outputs: { data: "${{ result.stdout }}" } },
          second: { ...step("./second.sh", "report"), outputs: { data: "${{ result.stdout }}" } },
          report: {
            ...step("./report.sh", null),
            inputs: {
              first: "${{ steps.first.outputs.data }}",
              second: "${{ steps.second.outputs.data }}",
            },
          },
        },
      },
      {},
      { "./first.sh": half, "./second.sh": half },
    );

    expect(result).toMatchObject({ error: { cause: { type: "InputTooLarge" } }, ok: false });
    expect(requests.map(({ run: command }) => command)).toEqual(["./first.sh", "./second.sh"]);
  }, 60_000);

  it("rejects an unknown input reference before running any step", async () => {
    const { requests, result } = await run({
      ...intermediate,
      steps: {
        fetch: step("./fetch.sh", "report"),
        report: {
          ...step("./report.sh", null),
          inputs: { title: "${{ steps.fetch.outputs.title }}" },
        },
      },
    });

    expect(result).toMatchObject({ error: { cause: { type: "InvalidIntermediate" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);

  const withWorkflowInput: Intermediate = {
    ...intermediate,
    inputs: {
      level: { options: ["low", "high"], required: true, type: "choice" },
      note: { required: false, type: "string" },
      threshold: { default: 1.5, required: false, type: "number" },
    },
    steps: {
      fetch: {
        ...step('./fetch.sh "${{ inputs.threshold }}" "${{ inputs.note }}"', null),
        inputs: {
          level: "${{ workflow.inputs.level }}",
          note: "${{ workflow.inputs.note }}",
          threshold: "${{ workflow.inputs.threshold }}",
        },
      },
    },
  };

  it("passes the workflow input to steps with defaults applied", async () => {
    const { requests, result } = await run(withWorkflowInput, {}, {}, { level: "high" });

    expect(result).toEqual({ ok: true, value: { executedSteps: ["fetch"] } });
    expect(requests).toEqual([
      {
        inputs: { level: "high", note: null, threshold: 1.5 },
        run: './fetch.sh "1.5" ""',
        timeoutMs: 5000,
      },
    ]);
  }, 60_000);

  it("expands earlier outputs and the workflow input in run directly", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        inputs: { prefix: { default: "pre", required: false, type: "string" } },
        steps: {
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: step(
            './report.sh "${{ workflow.inputs.prefix }}" "${{ steps.fetch.outputs.title }}"',
            null,
          ),
        },
      },
      {},
      { "./fetch.sh": "hello\n" },
      {},
    );

    expect(result).toEqual({ ok: true, value: { executedSteps: ["fetch", "report"] } });
    expect(requests.at(-1)).toEqual({
      inputs: {},
      run: './report.sh "pre" "hello"',
      timeoutMs: 5000,
    });
  }, 60_000);

  it("sends only the referenced values to a step", async () => {
    const { stepRequests } = await run(
      {
        ...intermediate,
        inputs: {
          level: { default: "high", required: false, type: "string" },
          unused: { default: "x", required: false, type: "string" },
        },
        steps: {
          fetch: {
            ...step("./fetch.sh", "report"),
            outputs: { title: "${{ result.stdout }}", unused: "${{ result.stderr }}" },
          },
          report: {
            ...step("./report.sh ${{ steps.fetch.outputs.title }}", null),
            outputs: { level: "${{ workflow.inputs.level }}" },
          },
        },
      },
      {},
      { "./fetch.sh": "hello" },
      {},
    );

    expect(stepRequests.at(-1)?.references).toEqual({
      steps: { fetch: { outputs: { title: "hello" } } },
      workflow: { inputs: { level: "high" } },
    });
  }, 60_000);

  it("fails when the referenced values exceed the size limit", async () => {
    const half = "x".repeat(300 * 1024);
    const { requests, result } = await run(
      {
        ...intermediate,
        start: "first",
        steps: {
          first: { ...step("./first.sh", "second"), outputs: { data: "${{ result.stdout }}" } },
          second: { ...step("./second.sh", "report"), outputs: { data: "${{ result.stdout }}" } },
          report: step(
            './report.sh "${{ steps.first.outputs.data }}" "${{ steps.second.outputs.data }}"',
            null,
          ),
        },
      },
      {},
      { "./first.sh": half, "./second.sh": half },
    );

    expect(result).toMatchObject({ error: { cause: { type: "InputTooLarge" } }, ok: false });
    expect(requests.map(({ run: command }) => command)).toEqual(["./first.sh", "./second.sh"]);
  }, 60_000);

  it("rejects invalid workflow input before running any step", async () => {
    const { requests, result } = await run(withWorkflowInput, {}, {}, { level: "mid" });

    expect(result).toMatchObject({
      error: {
        cause: { message: "workflow.inputs.level: Must be one of low, high", type: "InvalidInput" },
      },
      ok: false,
    });
    expect(requests).toEqual([]);
  }, 60_000);

  it("rejects missing required workflow input when started without it", async () => {
    const { result } = await run(withWorkflowInput);

    expect(result).toMatchObject({ error: { cause: { type: "InvalidInput" } }, ok: false });
  }, 60_000);

  it("rejects a wait step whose method describes no answers", async () => {
    const { requests, result } = await run({
      ...intermediate,
      steps: {
        ...intermediate.steps,
        fetch: {
          inputs: {},
          method: "terminal",
          next: { step: "report", type: "step" },
          outputs: {},
          type: "wait",
          with: { message: "Continue?" },
        },
      },
    });

    expect(result).toMatchObject({ error: { cause: { type: "UnsupportedStep" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);

  it("rejects an invalid intermediate representation", async () => {
    const { requests, result } = await run({ ...intermediate, start: "missing" });

    expect(result).toMatchObject({ error: { cause: { type: "InvalidIntermediate" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);
});
