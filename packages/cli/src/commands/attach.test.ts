import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { PassThrough, Readable } from "node:stream";

import { createFileEventLog } from "@ugoke/adapter-event-log-file";
import { createLocalScriptRunner } from "@ugoke/adapter-script-local";
import { intermediateVersion } from "@ugoke/core";
import {
  startWorker,
  startWorkflow,
  workflowCodeVersion,
  workflowCodeVersionMemoKey,
} from "@ugoke/engine";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { daemonPaths } from "../daemon/paths.ts";
import { loadEncryptionKey } from "../encryption.ts";
import { acquireRunLock } from "../lock.ts";
import { listProjectRuns } from "../runs.ts";
import {
  projectHash,
  projectLockDirectory,
  projectLogDirectory,
  projectMemoKey,
  workflowMemoKey,
} from "../state.ts";
import { createOutput, fixtureProject } from "../testing.ts";
import { attach, cancel } from "./attach.ts";
import { run } from "./run.ts";

const root = realpathSync(fixtureProject);

describe("attach and cancel", () => {
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

  /** Starts a workflow that waits for an answer, and detaches it. */
  const detachWaiting = async (): Promise<string> => {
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
    return detached.workflowId;
  };

  const execute = async (
    command: typeof attach,
    workflowId?: string,
    stdin = "",
    target: Parameters<typeof attach>[0]["server"] = server(),
  ) => {
    const output = createOutput();
    const exitCode = await command(
      { server: target, signal: new AbortController().signal, version: "0.0.0", workflowId },
      {
        cwd: fixtureProject,
        stderr: output.stderr,
        stdin: () => Readable.from([stdin]),
        stdout: output.stdout,
      },
    );
    return { exitCode, ...output.written };
  };

  it("lists the runs of the project and attaches to the selected one", async () => {
    const workflowId = await detachWaiting();
    const runs = await listProjectRuns(environment.address, root);
    const index = runs.findIndex((candidate) => candidate.workflowId === workflowId) + 1;

    const result = await execute(attach, undefined, `${index}\nschrosis\ny\n`);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain(
      `${index}. wait-valid  waiting at ask: Hello, what is your name?  started just now\n`,
    );
    // The run that it attaches to shows the earlier progress, and continues from the wait step.
    expect(result.stdout).toMatch(
      /Select a run \(1-\d+\): \d+\nask\n│ > Hello, what is your name\?\nname \(string, required\): schrosis\n/u,
    );
    expect(result.stdout).toContain("Hello schrosis!!\n");
    expect(result.stdout).toContain("wait-valid: completed (ask, greet)\n");
  }, 60_000);

  it("cancels a run of the project", async () => {
    const workflowId = await detachWaiting();

    await expect(execute(cancel, workflowId)).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "wait-valid: cancelled\n",
    });
    const runs = await listProjectRuns(environment.address, root);
    expect(runs.map((candidate) => candidate.workflowId)).not.toContain(workflowId);
  }, 60_000);

  it("does not attach to a run that another process follows", async () => {
    const workflowId = await detachWaiting();
    const lock = acquireRunLock(projectLockDirectory(root), workflowId);
    try {
      const result = await execute(attach, workflowId);

      expect(result).toMatchObject({ exitCode: 1 });
      expect(result.stderr).toBe(
        `wait-valid: Another process (${process.pid}) already follows ${workflowId}\n`,
      );
    } finally {
      lock.release();
      await execute(cancel, workflowId);
    }
  }, 60_000);

  it("does not attach to a run of another version, and terminates it to cancel it", async () => {
    const handle = await environment.client.workflow.start("ugoke", {
      args: [
        {
          inputs: {},
          start: "wait",
          steps: {
            wait: {
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
        {},
      ],
      memo: {
        [projectMemoKey]: projectHash(root),
        [workflowCodeVersionMemoKey]: "0",
        [workflowMemoKey]: "old",
      },
      taskQueue: `ugoke-${randomUUID()}`,
      workflowId: `old-${randomUUID()}`,
    });

    const listed = await execute(attach, undefined, "");
    expect(listed.stdout).toMatch(
      /\d+\. old {2}starting {2}started just now {2}\(started by another version of ugoke\)\n/u,
    );

    const attached = await execute(attach, handle.workflowId);
    expect(attached).toMatchObject({ exitCode: 1 });
    expect(attached.stderr).toContain("was started by workflow code version 0");
    expect(attached.stderr).toContain("pass --force to try anyway");

    await expect(execute(cancel, handle.workflowId)).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout:
        "old: terminated instead of cancelled, because workflow code version 0 started it. Its running script, if any, stops at its next heartbeat\n",
    });
    await expect(handle.describe()).resolves.toMatchObject({ status: { name: "TERMINATED" } });
  }, 60_000);

  it("leaves a run to a resident process of another ugoke version that still serves its queue", async () => {
    // A short directory keeps the socket path within the limit of the platform.
    const state = mkdtempSync("/tmp/ugoke-attach-");
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    const taskQueue = `ugoke-project-${randomUUID()}`;
    // The Worker of the resident process, which has the same workflow code version.
    const worker = await startWorker({
      address: environment.address,
      encryptionKey: loadEncryptionKey(),
      eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
      scriptRunner: createLocalScriptRunner({ cwd: root }),
      taskQueue,
    });
    // The resident process has another ugoke version, and serves the project on that queue.
    const paths = daemonPaths();
    mkdirSync(paths.directory, { recursive: true });
    const daemon = createServer((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          address: environment.address,
          pid: 1,
          projects: [{ root, running: true, taskQueue }],
          serverOptions: "",
          startedAt: "",
          version: "9.9.9",
          workflowCodeVersion,
        }),
      );
    });
    await new Promise<void>((resolve) => daemon.listen(paths.socket, resolve));
    try {
      // ugoke run --detach starts a run like this, on the task queue of the resident process.
      const workflowId = await startWorkflow({
        address: environment.address,
        encryptionKey: loadEncryptionKey(),
        intermediate: {
          inputs: {},
          start: "wait",
          steps: {
            wait: {
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
        memo: { [projectMemoKey]: projectHash(root), [workflowMemoKey]: "queued" },
        name: "queued",
        taskQueue,
      });
      const output = createOutput();
      const exitCode = await attach(
        { signal: new AbortController().signal, version: "0.0.0", workflowId },
        {
          cwd: fixtureProject,
          stderr: output.stderr,
          stdin: () => Readable.from(["\n"]),
          stdout: output.stdout,
        },
      );

      expect(exitCode, `${output.written.stdout}${output.written.stderr}`).toBe(0);
      expect(output.written.stderr).toContain(
        "queued: ugoke daemon goes on running the steps of this run, because the run is on its task queue, so this command follows it without its own Worker\n",
      );
      expect(output.written.stdout).toContain("queued: completed (wait)\n");
    } finally {
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      await worker.stop();
      if (previous === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previous;
      }
      rmSync(state, { force: true, recursive: true });
    }
  }, 60_000);

  it("reports a run that is not running in the project", async () => {
    await expect(execute(attach, "missing-1")).resolves.toEqual({
      exitCode: 1,
      stderr: "No running run missing-1 in this project\n",
      stdout: "",
    });
  }, 60_000);
});
