import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createPluginRegistry, definePlugin, intermediateVersion } from "@ugoke/core";
import type { Intermediate } from "@ugoke/core";
import { Client } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { createActivities } from "../activities/index.ts";
import { createMemoryEventLog } from "../events.ts";
import { answerUpdateName, waitingQueryName } from "../messages.ts";
import type { Answer } from "../messages.ts";
import { workflowCodeVersion } from "../version.ts";
import { ugoke } from "./index.ts";

/**
 * Replay tests: the histories of earlier runs must replay with the current workflow code.
 *
 * A change that fails these tests would break runs that wait in Temporal. Make the change
 * replay, such as with `patched()`. Otherwise, raise `workflowCodeVersion`, delete the histories
 * of the earlier version, record new ones with `UGOKE_RECORD_HISTORIES=1 pnpm --filter
 * @ugoke/engine test`, and run the tests again. Only the histories of the current version are
 * replayed, because the earlier ones need the earlier code.
 */
const recording = process.env.UGOKE_RECORD_HISTORIES === "1";
const historiesDirectory = fileURLToPath(new URL("../../test/histories/", import.meta.url));
const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));

const script = (run: string, next: string | null, fields: object = {}) => ({
  inputs: {},
  next: next === null ? { type: "end" as const } : { step: next, type: "step" as const },
  outputs: {},
  run,
  timeoutMs: 5000,
  type: "script" as const,
  ...fields,
});

/** Runs that cover the paths of the workflow code. */
const scenarios: Record<
  string,
  { intermediate: Intermediate; inputs: object; drive?: (handle: WorkflowHandle) => Promise<void> }
> = {
  scripts: {
    inputs: { prefix: "pre" },
    intermediate: {
      inputs: { prefix: { required: true, type: "string" } },
      start: "fetch",
      steps: {
        fetch: script("echo hello", "report", { outputs: { title: "${{ result.stdout }}" } }),
        report: script(
          'echo "${{ workflow.inputs.prefix }} ${{ steps.fetch.outputs.title }}"',
          null,
        ),
      },
      version: intermediateVersion,
    },
  },
  loop: {
    inputs: {},
    intermediate: {
      inputs: {},
      start: "implement",
      steps: {
        implement: script("echo [${{ steps.review.visits[0].outputs.note }}]", "review", {
          maxVisits: 5,
          outputs: { value: "${{ result.stdout }}" },
        }),
        // It goes back once, until the second visit of implement has an output.
        review: script("echo review", null, {
          next: {
            branches: [
              {
                if: "${{ steps.implement.visits[1].outputs.value == null }}",
                to: { step: "implement", type: "step" },
              },
              { to: { type: "end" } },
            ],
            type: "branch",
          },
          outputs: { note: "${{ result.stdout }}" },
        }),
      },
      version: intermediateVersion,
    },
  },
  branch: {
    drive: async (handle) => {
      await waitForStep(handle);
      await handle.executeUpdate(answerUpdateName, {
        args: [await answerOf(handle, { go: true })],
      });
    },
    inputs: {},
    intermediate: {
      inputs: {},
      start: "check",
      steps: {
        after: script("echo after", null),
        ask: {
          answers: { go: { required: true, type: "boolean" } },
          inputs: {},
          method: "terminal",
          next: {
            branches: [
              { if: "${{ result.go == true }}", to: { step: "after", type: "step" } },
              { to: { type: "end" } },
            ],
            type: "branch",
          },
          outputs: {},
          type: "wait",
          with: { message: "Continue?" },
        },
        check: script("echo check", null, {
          next: {
            branches: [
              { if: "${{ result.stdout == 'x' }}", to: { step: "ask", type: "step" } },
              { to: { type: "end" } },
            ],
            type: "branch",
          },
        }),
      },
      version: intermediateVersion,
    },
  },
  ai: {
    inputs: {},
    intermediate: {
      env: { LEVEL: "info" },
      inputs: {},
      start: "review",
      steps: {
        report: script("echo ${{ steps.review.outputs.verdict }}", null),
        review: {
          inputs: {},
          next: { step: "report", type: "step" },
          outputs: { verdict: "${{ result.data.verdict }}" },
          prompt: "Review",
          provider: "claude-code",
          schema: { type: "object" },
          session: "reuse",
          timeoutMs: 5000,
          type: "ai",
          with: { note: "x" },
        },
      },
      version: intermediateVersion,
    },
  },
  helpers: {
    inputs: { title: "  hello \n" },
    intermediate: {
      // The workflow evaluates the calls in env and inputs.
      env: { TITLE: "${{ trim(workflow.inputs.title) }}" },
      inputs: { title: { required: true, type: "string" } },
      start: "fetch",
      steps: {
        check: script("echo check", null, {
          next: {
            branches: [
              // The workflow passes the reference in the argument to the activity.
              { if: "${{ trim(steps.fetch.outputs.value) == 'x' }}", to: { type: "end" } },
              { to: { type: "end" } },
            ],
            type: "branch",
          },
        }),
        fetch: script("echo ${{ inputs.title }}", "check", {
          inputs: { title: "${{ trim(workflow.inputs.title) }}" },
          outputs: { value: "${{ trim(result.stdout) }}" },
        }),
      },
      version: intermediateVersion,
    },
  },
  wait: {
    drive: async (handle) => {
      await waitForStep(handle);
      await handle.executeUpdate(answerUpdateName, {
        args: [await answerOf(handle, { name: "ugoke" })],
      });
    },
    inputs: {},
    intermediate: {
      inputs: {},
      start: "ask",
      steps: {
        ask: {
          answers: { name: { required: true, type: "string" } },
          inputs: {},
          method: "terminal",
          next: { step: "greet", type: "step" },
          outputs: { name: "${{ result.name }}" },
          type: "wait",
          with: { message: "Name?" },
        },
        greet: script('echo "${{ steps.ask.outputs.name }}"', null),
      },
      version: intermediateVersion,
    },
  },
  "wait-worker": {
    inputs: { greeting: "Hello" },
    intermediate: {
      inputs: { greeting: { required: true, type: "string" } },
      start: "ask",
      steps: {
        ask: {
          answers: { name: { required: true, type: "string" } },
          inputs: {},
          method: "chat",
          next: { step: "greet", type: "step" },
          outputs: { name: "${{ result.name }}" },
          respondIn: "worker",
          type: "wait",
          with: { message: "${{ workflow.inputs.greeting }}, who are you?" },
        },
        greet: script('echo "${{ steps.ask.outputs.name }}"', null),
      },
      version: intermediateVersion,
    },
  },
  "wait-cancelled": {
    drive: async (handle) => {
      await waitForStep(handle);
      await handle.cancel();
    },
    inputs: {},
    intermediate: {
      inputs: {},
      start: "ask",
      steps: {
        ask: {
          answers: {},
          inputs: {},
          method: "terminal",
          next: { type: "end" },
          outputs: {},
          type: "wait",
          with: { message: "Continue?" },
        },
      },
      version: intermediateVersion,
    },
  },
  whitespace: {
    drive: async (handle) => {
      await waitForStep(handle);
      await handle.executeUpdate(answerUpdateName, {
        args: [await answerOf(handle, { count: 2 })],
      });
    },
    inputs: { count: 1 },
    intermediate: {
      // The workflow evaluates env, the inputs of a step, and the with and outputs of a wait step.
      env: { COUNT: "${{ workflow.inputs.count }}\n" },
      inputs: { count: { required: true, type: "number" } },
      start: "fetch",
      steps: {
        fetch: script("echo ${{ inputs.count }}", "ask", {
          inputs: { count: "  ${{ workflow.inputs.count }}\n" },
          outputs: { code: "${{ result.exitCode }}\n" },
        }),
        ask: {
          answers: { count: { required: true, type: "number" } },
          inputs: {},
          method: "terminal",
          // The branch is chosen by a local activity, whose input would differ on replay if the
          // evaluation of the templates changed.
          next: {
            branches: [
              { if: "${{ outputs.count == 2 }}", to: { step: "report", type: "step" } },
              { to: { type: "end" } },
            ],
            type: "branch",
          },
          outputs: { count: "\n${{ result.count }}\n" },
          type: "wait",
          with: { message: "${{ steps.fetch.outputs.code }}\n" },
        },
        report: script('echo "${{ steps.ask.outputs.count }}"', null),
      },
      version: intermediateVersion,
    },
  },
};

/** Builds an answer for the first visit of the step "ask" of the run. */
const answerOf = async (
  handle: WorkflowHandle,
  values: Record<string, unknown>,
): Promise<Answer> => ({
  runId: (await handle.describe()).runId,
  step: "ask",
  values,
  visit: 0,
  workflowId: handle.workflowId,
});

const waitForStep = async (handle: WorkflowHandle): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await handle.query(waitingQueryName)) !== null) {
      return;
    }
    await sleep(50);
  }
  throw new Error("The workflow did not wait");
};

/**
 * Identity of the client and the Workers that record the histories. Temporal defaults to the
 * process ID and the host name, which would put the name of the machine into the histories.
 */
const recorderIdentity = "ugoke-replay-recorder";

const historyFile = (name: string): string =>
  `${historiesDirectory}v${workflowCodeVersion}-${name}.json`;

/** Records the histories of the scenarios. */
const record = async (): Promise<void> => {
  const environment = await TestWorkflowEnvironment.createLocal({
    server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
  });
  const client = new Client({ connection: environment.connection, identity: recorderIdentity });
  try {
    mkdirSync(historiesDirectory, { recursive: true });
    for (const [name, { drive, inputs, intermediate }] of Object.entries(scenarios)) {
      const taskQueue = randomUUID();
      const worker = await Worker.create({
        activities: createActivities({
          aiRunner: { run: async () => ({ data: { verdict: "approve" }, sessionId: "session" }) },
          eventLog: createMemoryEventLog(),
          plugins: createPluginRegistry({
            builtins: [
              definePlugin({
                name: "test",
                waitMethods: [
                  {
                    name: "chat",
                    respond: async () => ({ name: "ugoke" }),
                    respondIn: "worker",
                    with: z.strictObject({ message: z.string() }),
                  },
                ],
              }),
            ],
          }),
          scriptRunner: {
            run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "x\n" }),
          },
        }),
        connection: environment.nativeConnection,
        identity: recorderIdentity,
        taskQueue,
        workflowsPath,
      });
      await worker.runUntil(async () => {
        const handle = await client.workflow.start(ugoke, {
          args: [intermediate, inputs],
          taskQueue,
          workflowId: `replay-${name}`,
        });
        await drive?.(handle);
        await handle.result().catch(() => {});
        writeFileSync(historyFile(name), `${historyToJSON(await handle.fetchHistory())}\n`);
      });
    }
  } finally {
    await environment.teardown();
  }
};

// Recording writes the histories only. The next run of the tests replays them.
describe.runIf(recording)("ugoke replay recording", () => {
  it("records the histories of the scenarios", record, 120_000);
});

describe.skipIf(recording)("ugoke replay", () => {
  const files = readdirSync(historiesDirectory).filter(
    (file) => file.startsWith(`v${workflowCodeVersion}-`) && file.endsWith(".json"),
  );

  it("has histories of the current workflow code version", () => {
    expect(files).toEqual(
      expect.arrayContaining(
        Object.keys(scenarios).map((name) => `v${workflowCodeVersion}-${name}.json`),
      ),
    );
  });

  it.each(files)(
    "replays %s",
    async (file) => {
      const history: unknown = JSON.parse(readFileSync(`${historiesDirectory}${file}`, "utf8"));
      await Worker.runReplayHistory({ workflowsPath }, history);
    },
    60_000,
  );
});
