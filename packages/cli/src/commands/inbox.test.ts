import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { startWorker } from "@ugoke/engine";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { loadEncryptionKey } from "../encryption.ts";
import { listProjectRuns } from "../runs.ts";
import { createOutput, fixtureProject } from "../testing.ts";
import { answerInboxCommand, formatQuestion, listInboxCommand } from "./inbox.ts";
import { cancel } from "./attach.ts";
import { run } from "./run.ts";

const root = realpathSync(fixtureProject);

/** Parses the JSON lines of --from-ai. */
const lines = (stdout: string): Record<string, unknown>[] =>
  stdout
    .trimEnd()
    .split("\n")
    .map((line): Record<string, unknown> => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Not a JSON object: ${line}`);
      }
      return { ...parsed };
    });

describe("inbox", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const server = () => ({ address: environment.address, type: "address" as const });
  const signal = new AbortController().signal;

  /** Starts a workflow that waits for an answer, and detaches it. */
  const detachWaiting = async (): Promise<{ workflowId: string; taskQueue: string }> => {
    const controller = new AbortController();
    const output = createOutput();
    // The input never ends, so the wait step keeps waiting until the run detaches.
    const input = new PassThrough();
    const exitCode = await run(
      "wait-valid",
      { server: server(), signal: controller.signal, version: "0.0.0" },
      {
        cwd: fixtureProject,
        stderr: output.stderr,
        stdin: () => input,
        stdout: (text) => {
          output.stdout(text);
          if (text.startsWith("name (string, required): ")) {
            controller.abort();
          }
        },
      },
    );
    expect(exitCode).toBe(3);
    const runs = await listProjectRuns(environment.address, root);
    const detached = runs.find(({ name }) => name === "wait-valid");
    if (detached === undefined) {
      throw new Error("The detached run is not listed");
    }
    return detached;
  };

  const list = async (cwd = fixtureProject) => {
    const output = createOutput();
    const exitCode = await listInboxCommand(
      { server: server(), version: "0.0.0" },
      { cwd, stderr: output.stderr, stdout: output.stdout },
    );
    return { exitCode, ...output.written };
  };

  const answer = async (workflowId: string, values: string) => {
    const output = createOutput();
    const exitCode = await answerInboxCommand(
      { server: server(), signal, step: "ask", values, version: "0.0.0", visit: 0, workflowId },
      { cwd: fixtureProject, stderr: output.stderr, stdout: output.stdout },
    );
    return { exitCode, ...output.written };
  };

  const cancelRun = async (workflowId: string): Promise<void> => {
    const output = createOutput();
    await cancel(
      { server: server(), signal, version: "0.0.0", workflowId },
      { cwd: fixtureProject, stderr: output.stderr, stdout: output.stdout },
    );
  };

  it("lists a question with the command that answers it", async () => {
    const { taskQueue, workflowId } = await detachWaiting();
    // A Worker serves the run, as the resident process does.
    const worker = await startWorker({
      address: environment.address,
      encryptionKey: loadEncryptionKey(),
      eventLog: { append: () => {}, read: async () => ({ cursor: "", events: [] }) },
      scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      taskQueue,
    });
    try {
      const result = await list();

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain(
        [
          `${workflowId}  wait-valid  ask (visit 0)  started just now`,
          '  inputs: {"greeting":"Hello"}',
          "  │ Hello, what is your name?",
          "  answers:",
          "    name: string (required)",
          "    approve: boolean",
          // The resident process does not run it, so ugoke inbox answer would refuse it.
          `  ugoke attach ${workflowId} --address ${environment.address}  (ugoke daemon does not run it)`,
        ].join("\n"),
      );
    } finally {
      await worker.stop();
      await cancelRun(workflowId);
    }
  }, 60_000);

  it("reports a run that no Worker serves, and how to follow it", async () => {
    const { workflowId } = await detachWaiting();
    try {
      const result = await list();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${workflowId}: cannot read what it waits for: `);
      expect(result.stderr).toContain(
        `Run "ugoke attach ${workflowId} --address ${environment.address}" to follow it\n`,
      );
    } finally {
      await cancelRun(workflowId);
    }
  }, 60_000);

  it("does not answer a run that the resident process does not run", async () => {
    const { workflowId } = await detachWaiting();
    try {
      await expect(answer(workflowId, '{"name":"ugoke"}')).resolves.toEqual({
        exitCode: 1,
        stderr: `wait-valid: ugoke daemon does not run ${workflowId}, so it would stop after the answer. Run "ugoke attach ${workflowId} --address ${environment.address}" to answer and follow it\n`,
        stdout: "",
      });
    } finally {
      await cancelRun(workflowId);
    }
  }, 60_000);

  it("rejects values that are not a JSON object", async () => {
    await expect(answer("wait-valid-1", "name=ugoke")).resolves.toEqual({
      exitCode: 1,
      stderr: "--values must be a JSON object or the path of a .json file: name=ugoke\n",
      stdout: "",
    });
  });

  it("reports a run that is not running in the project", async () => {
    await expect(answer("missing-1", "{}")).resolves.toEqual({
      exitCode: 1,
      stderr: "No running run missing-1 in this project\n",
      stdout: "",
    });
  }, 60_000);

  it("tells how to answer a run that the resident process runs", () => {
    const question = {
      answers: { ok: { required: true, type: "boolean" as const } },
      method: "terminal",
      options: { message: "Deploy?" },
      run: { memo: {}, startTime: new Date(), taskQueue: "served", workflowId: "deploy-1" },
      step: "approve",
      visit: 2,
    };

    expect(formatQuestion(question, { servedTaskQueue: "served", serverOptions: "" })).toBe(
      [
        "deploy-1  approve (visit 2)  started just now",
        "  │ Deploy?",
        "  answers:",
        "    ok: boolean (required)",
        "  ugoke inbox answer deploy-1 --step approve --visit 2 --values '{...}' --detach",
        "",
      ].join("\n"),
    );
  });

  it("lets a program run a workflow question by question, without the resident process", async () => {
    const started = createOutput();
    const runExitCode = await run(
      "wait-valid",
      { fromAi: true, server: server(), signal, version: "0.0.0" },
      { cwd: fixtureProject, stderr: started.stderr, stdout: started.stdout },
    );

    expect(runExitCode).toBe(3);
    const runLines = lines(started.written.stdout);
    const workflowId = runLines[0]?.workflowId;
    expect(runLines).toEqual([
      { name: "wait-valid", type: "started", workflowId },
      { message: "Hello, what is your name?", step: "ask", type: "stepStarted" },
      {
        answers: {
          approve: { required: false, type: "boolean" },
          name: { required: true, type: "string" },
        },
        inputs: { greeting: "Hello" },
        message: "Hello, what is your name?",
        name: "wait-valid",
        step: "ask",
        type: "question",
        visit: 0,
        workflowId,
      },
    ]);
    if (typeof workflowId !== "string") {
      throw new Error("The run reported no workflow ID");
    }

    // No Worker serves the run after the command exited.
    const listed = createOutput();
    await listInboxCommand(
      { fromAi: true, server: server(), version: "0.0.0" },
      { cwd: fixtureProject, ...listed },
    );
    expect(lines(listed.written.stdout)).toContainEqual({
      reason: expect.any(String) as unknown,
      type: "unreadable",
      workflowId,
    });

    const answered = createOutput();
    const answerExitCode = await answerInboxCommand(
      {
        fromAi: true,
        server: server(),
        signal,
        step: "ask",
        values: '{"name":"ugoke"}',
        version: "0.0.0",
        visit: 0,
        workflowId,
      },
      { cwd: fixtureProject, ...answered },
    );

    expect({ exitCode: answerExitCode, stderr: answered.written.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const answerLines = lines(answered.written.stdout);
    // The program saw the progress up to the question, so only what follows the answer comes.
    expect(answerLines[0]).toEqual({ step: "ask", type: "answered", visit: 0, workflowId });
    expect(answerLines.map(({ step, type }) => `${String(type)} ${String(step)}`)).toEqual([
      "answered ask",
      "stepFinished ask",
      "stepStarted greet",
      "stepFinished greet",
      "completed undefined",
    ]);
    expect(answerLines.at(-1)).toEqual({
      executedSteps: ["ask", "greet"],
      type: "completed",
      workflowId,
    });
  }, 60_000);

  it("reports a rejected answer as the last line, and the run keeps waiting", async () => {
    const { workflowId } = await detachWaiting();
    try {
      const output = createOutput();
      const exitCode = await answerInboxCommand(
        {
          fromAi: true,
          server: server(),
          signal,
          step: "ask",
          values: '{"name":1}',
          version: "0.0.0",
          visit: 0,
          workflowId,
        },
        { cwd: fixtureProject, ...output },
      );

      expect(exitCode).toBe(1);
      expect(lines(output.written.stdout)).toEqual([
        { message: "ask.name: Must be a string", type: "failed" },
      ]);
      const runs = await listProjectRuns(environment.address, root);
      expect(runs.map((candidate) => candidate.workflowId)).toContain(workflowId);
    } finally {
      await cancelRun(workflowId);
    }
  }, 60_000);

  it("needs a project", async () => {
    await expect(list(tmpdir())).resolves.toMatchObject({ exitCode: 1, stdout: "" });
  });
});
