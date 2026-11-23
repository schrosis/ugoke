import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { intermediateVersion } from "@ugoke/core";
import type { Intermediate, ScriptRequest } from "@ugoke/core";
import { Client } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import { RawValue } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

import { createActivities } from "../activities/index.ts";
import { clientDataConverter, workerDataConverter } from "../encryption.ts";
import { sendAnswer } from "../inbox.ts";
import { answerUpdateName, waitingQueryName } from "../messages.ts";
import { listRunningWorkflows } from "../run.ts";
import { ugoke } from "./index.ts";

const approval: Intermediate = {
  inputs: {},
  start: "approve",
  steps: {
    approve: {
      answers: { ok: { required: true, type: "boolean" } },
      inputs: {},
      method: "terminal",
      next: { type: "end" },
      outputs: {},
      type: "wait",
      with: { message: "Deploy?" },
    },
  },
  version: intermediateVersion,
};

const key = randomBytes(32);
const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const attackWorkflowsPath = fileURLToPath(
  new URL("../../test/fixtures/schedule-activity.ts", import.meta.url),
);

const intermediate: Intermediate = {
  inputs: {},
  start: "greet",
  steps: {
    greet: {
      inputs: {},
      next: { type: "end" },
      outputs: {},
      run: "echo secret-command",
      timeoutMs: 5000,
      type: "script",
    },
  },
  version: intermediateVersion,
};

const waitsForAnswer = async (handle: WorkflowHandle): Promise<boolean> =>
  (await handle.query(waitingQueryName)) !== null;

describe("ugoke with encryption", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  });

  afterAll(async () => {
    await environment?.teardown();
  });

  const createVictim = async (taskQueue: string, requests: ScriptRequest[]) =>
    Worker.create({
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
      workflowsPath,
      ...workerDataConverter(key),
    });

  it("runs a workflow without leaving its values in the history", async () => {
    const requests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await createVictim(taskQueue, requests);
    const client = new Client({
      connection: environment.connection,
      ...clientDataConverter(key),
    });

    await worker.runUntil(async () => {
      const handle = await client.workflow.start(ugoke, {
        args: [intermediate],
        taskQueue,
        workflowId: randomUUID(),
      });
      await expect(handle.result()).resolves.toEqual({ executedSteps: ["greet"] });
      const history = JSON.stringify(await handle.fetchHistory());
      expect(history).not.toContain(Buffer.from("secret-command").toString("base64"));
    });

    expect(requests).toHaveLength(1);
  }, 60_000);

  it("fails a workflow without leaving the message of the failure in the history", async () => {
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        scriptRunner: {
          run: async () => {
            throw new Error("secret-failure");
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      ...workerDataConverter(key),
    });
    const client = new Client({
      connection: environment.connection,
      ...clientDataConverter(key),
    });

    await worker.runUntil(async () => {
      const handle = await client.workflow.start(ugoke, {
        args: [intermediate],
        taskQueue,
        workflowId: randomUUID(),
      });
      const failure: unknown = await handle.result().catch((error: unknown) => error);
      expect(inspect(failure, { depth: 10 })).toContain("secret-failure");
      const history = JSON.stringify(await handle.fetchHistory());
      expect(history).not.toContain("secret-failure");
      expect(history).not.toContain("encryption.test.ts");
    });
  }, 60_000);

  it("does not take an answer that someone copies from the history of another run", async () => {
    const taskQueue = randomUUID();
    const worker = await createVictim(taskQueue, []);
    const client = new Client({
      connection: environment.connection,
      ...clientDataConverter(key),
    });
    const startWaiting = async (): Promise<WorkflowHandle> => {
      const handle = await client.workflow.start(ugoke, {
        args: [approval],
        taskQueue,
        workflowId: randomUUID(),
      });
      await vi.waitFor(async () => expect(await waitsForAnswer(handle)).toBe(true), 10_000);
      return handle;
    };

    await worker.runUntil(async () => {
      const answered = await startWaiting();
      const target = await startWaiting();
      await sendAnswer(answered, { step: "approve", values: { ok: true } });
      await answered.result();
      const { events } = await environment.client.workflow
        .getHandle(answered.workflowId)
        .fetchHistory();
      const copied = events
        ?.map((event) => event.workflowExecutionUpdateAcceptedEventAttributes)
        .find((attributes) => attributes !== null && attributes !== undefined)?.acceptedRequest
        ?.input?.args?.payloads?.[0];
      if (copied === undefined) {
        throw new Error("The history has no answer");
      }

      await expect(
        environment.client.workflow
          .getHandle(target.workflowId)
          .executeUpdate(answerUpdateName, { args: [RawValue.fromPayload(copied)] }),
      ).rejects.toThrow();

      await expect(waitsForAnswer(target)).resolves.toBe(true);
      await target.terminate();
    });
  }, 60_000);

  it("lists its own runs while runs of another key are on the server", async () => {
    const otherKey = randomBytes(32);
    const start = async (encryptionKey: Uint8Array, project: string): Promise<string> => {
      const workflowId = randomUUID();
      await new Client({
        connection: environment.connection,
        ...clientDataConverter(encryptionKey),
      }).workflow.start(ugoke, {
        args: [intermediate],
        memo: { project },
        taskQueue: randomUUID(),
        workflowId,
      });
      return workflowId;
    };
    await start(otherKey, "other");
    const own = await start(key, "own");
    const options = { address: environment.address, encryptionKey: key, memo: { project: "own" } };

    let runs = await listRunningWorkflows(options);
    for (let attempt = 0; attempt < 100 && runs.length === 0; attempt += 1) {
      await sleep(100);
      runs = await listRunningWorkflows(options);
    }

    expect(runs.map(({ workflowId }) => workflowId)).toEqual([own]);
  }, 60_000);

  it("does not run a workflow that someone without the key starts", async () => {
    const requests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await createVictim(taskQueue, requests);

    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(ugoke, {
        args: [intermediate],
        taskQueue,
        workflowExecutionTimeout: "3 seconds",
        workflowId: randomUUID(),
      });
      await expect(handle.result()).rejects.toThrow();
    });

    expect(requests).toEqual([]);
  }, 60_000);

  it("does not run an activity that someone without the key schedules", async () => {
    const requests: ScriptRequest[] = [];
    const victimQueue = randomUUID();
    const attackQueue = randomUUID();
    const victim = await createVictim(victimQueue, requests);
    const attacker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: attackQueue,
      workflowsPath: attackWorkflowsPath,
    });

    await victim.runUntil(async () =>
      attacker.runUntil(async () => {
        await expect(
          environment.client.workflow.execute("scheduleActivity", {
            args: [
              victimQueue,
              {
                inputs: {},
                outputs: {},
                references: {},
                run: "echo attacked",
                step: "attack",
                timeoutMs: 1000,
              },
            ],
            taskQueue: attackQueue,
            // The refusal is encrypted, so the workflow of the attacker cannot read it and waits.
            workflowExecutionTimeout: "3 seconds",
            workflowId: randomUUID(),
          }),
        ).rejects.toThrow();
      }),
    );

    expect(requests).toEqual([]);
  }, 60_000);
});
