import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";

import { fixtureProject, seedTemporalCli } from "../testing.ts";

// These tests run the built executable, so they depend on `pnpm build`.
const bin = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

describe("ugoke daemon", () => {
  let state: string;

  beforeEach(() => {
    // A short directory keeps the socket path within the limit of the platform.
    state = mkdtempSync("/tmp/ugoke-daemon-");
    seedTemporalCli(cacheHome(), inject("temporalCli"));
  });

  /** Directory that the tests pass as XDG_CACHE_HOME, which keeps the Temporal CLI. */
  const cacheHome = (): string => join(state, "cache");

  /** SQLite file that the development server of the resident process keeps its runs in. */
  const devDb = (): string => join(state, "ugoke", "temporal.db");

  /**
   * Pattern of the command line of the development server of the test.
   *
   * The resident process names the file by its real path, and /tmp is a link on macOS, so the
   * pattern starts at the directory of the test.
   */
  const devServerPattern = (): string => `--db-filename .*${basename(state)}/ugoke/temporal\\.db`;

  /** Returns the process IDs of the development servers that use the SQLite file of the test. */
  const devServers = (): string[] => {
    try {
      return execFileSync("pgrep", ["-f", "--", devServerPattern()], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter((line) => line !== "");
    } catch {
      return [];
    }
  };

  /** Returns every progress event that the runs of the test stored, as JSON Lines. */
  const runEvents = (): string => {
    const logs = join(state, "ugoke", "logs");
    try {
      return readdirSync(logs, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith("events.jsonl"))
        .map((file) => readFileSync(join(logs, file), "utf8"))
        .join("");
    } catch {
      return "";
    }
  };

  /** Stops processes that use the state of the test, such as a development server. */
  const stopLeftovers = (): void => {
    try {
      execFileSync("pkill", ["-f", "--", devServerPattern()]);
    } catch {
      // No process was left.
    }
  };

  afterEach(async () => {
    await execute(["daemon", "stop"]);
    stopLeftovers();
    rmSync(state, { force: true, recursive: true });
  });

  const execute = async (args: string[], cwd?: string) =>
    new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd,
        env: { ...process.env, XDG_CACHE_HOME: cacheHome(), XDG_STATE_HOME: state },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("exit", (exitCode) => resolve({ exitCode, stderr, stdout }));
    });

  const start = async () => execute(["daemon", "start"]);

  const daemonLog = (): string =>
    readFileSync(join(state, "ugoke", "daemon", "daemon.log"), "utf8");

  it("starts, reports, and stops the resident process", async () => {
    await expect(execute(["daemon", "status"])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "ugoke daemon: not running\n",
    });

    const started = await start();
    expect(started).toMatchObject({ exitCode: 0 });
    expect(started.stdout).toMatch(
      /^ugoke daemon: started \(pid \d+, server 127\.0\.0\.1:\d+, ugoke \d+\.\d+\.\d+\)\n$/u,
    );
    // The development server keeps its runs in the state directory, which only the owner reads.
    expect(devServers()).toHaveLength(1);
    expect(statSync(devDb()).mode & 0o777).toBe(0o600);
    // The Temporal CLI in the cache is used without a download.
    expect(daemonLog()).not.toContain("downloading Temporal CLI");
    // The same request needs no restart.
    await expect(start()).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: expect.stringMatching(/^ugoke daemon: already running \(pid \d+/u) as unknown,
    });

    const status = await execute(["daemon", "status"]);
    expect(status).toMatchObject({ exitCode: 0 });
    expect(status.stdout).toContain("ugoke daemon: running (pid ");
    expect(status.stdout).toContain(
      `log: ${join(realpathSync(state), "ugoke", "daemon", "daemon.log")}\n`,
    );

    await expect(execute(["daemon", "stop"])).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "ugoke daemon: stopped\n",
    });
    await expect(execute(["daemon", "status"])).resolves.toMatchObject({ exitCode: 1 });
    await expect(execute(["daemon", "stop"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ugoke daemon: not running\n",
    });
  }, 60_000);

  it("starts again after the resident process was killed", async () => {
    await start();
    const pid = Number(readFileSync(join(state, "ugoke", "daemon", "daemon.lock"), "utf8"));
    // Without a graceful stop, the lock and the socket stay behind.
    process.kill(pid, "SIGKILL");

    await expect(start()).resolves.toMatchObject({ exitCode: 0 });
    // The new process stopped the development server of the killed one, which used the same
    // SQLite file.
    expect(devServers()).toHaveLength(1);
    expect(daemonLog()).toContain("stopping the development server that was left running");
  }, 60_000);

  it("runs the steps of a run that ugoke run detached", async () => {
    await start();
    const run = await new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, "run", "run-detach"], {
        cwd: fixtureProject,
        env: { ...process.env, XDG_CACHE_HOME: cacheHome(), XDG_STATE_HOME: state },
      });
      let output = "";
      let interrupted = false;
      const collect = (chunk: Buffer): void => {
        output += chunk.toString();
        // Interrupt once the script runs, which the resident process runs. A second interrupt
        // would exit at once.
        if (!interrupted && output.includes("sleep 2 && echo built\n")) {
          interrupted = true;
          child.kill("SIGINT");
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("exit", (exitCode) => resolve({ exitCode, output }));
    });

    // ugoke run detached at once, because the resident process runs the script.
    expect(run.exitCode).toBe(3);
    expect(run.output).not.toContain("Waiting for the running step");
    expect(run.output).toContain('run-detach: detached. Run "ugoke attach" to continue\n');

    // The resident process finishes the run in the background.
    const finished = '"outcome":"succeeded","step":"report","type":"stepFinished"';
    for (let attempt = 0; attempt < 100 && !runEvents().includes(finished); attempt += 1) {
      await sleep(100);
    }
    expect(runEvents()).toContain(finished);

    const status = await execute(["daemon", "status"]);
    expect(status.stdout).toContain(`projects:\n  ${realpathSync(fixtureProject)}\n`);
  }, 60_000);

  it("tells that it is stopping while it waits for a running step", async () => {
    await start();
    await expect(execute(["run", "run-stop", "--detach"], fixtureProject)).resolves.toMatchObject({
      exitCode: 0,
    });
    const started = '"step":"build","type":"stepStarted"';
    for (let attempt = 0; attempt < 100 && !runEvents().includes(started); attempt += 1) {
      await sleep(100);
    }
    expect(runEvents()).toContain(started);

    // The resident process stops after the script, which goes on for some seconds.
    const stopped = execute(["daemon", "stop"]);
    let status = await execute(["daemon", "status"]);
    for (let attempt = 0; attempt < 50 && !status.stdout.includes("stopping"); attempt += 1) {
      await sleep(100);
      status = await execute(["daemon", "status"]);
    }
    expect(status).toMatchObject({ exitCode: 1, stderr: "" });
    expect(status.stdout).toMatch(
      /^ugoke daemon: stopping \(pid \d+, server 127\.0\.0\.1:\d+, ugoke \d+\.\d+\.\d+\)\nIt waits for the steps that it runs to finish, and takes no new run\nlog: .+\n$/u,
    );

    const [startedAgain, run, stoppedAgain] = await Promise.all([
      start(),
      execute(["run", "run-success"], fixtureProject),
      execute(["daemon", "stop"]),
    ]);
    expect(startedAgain).toMatchObject({ exitCode: 1, stdout: "" });
    expect(startedAgain.stderr).toMatch(
      /^ugoke daemon: is stopping \(pid \d+\), and waits for the steps that it runs to finish\. Run "ugoke daemon start" again after it stopped\n$/u,
    );
    expect(run).toEqual({
      exitCode: 1,
      stderr:
        'run-success: failed: ugoke daemon is stopping. Run "ugoke daemon start" after it stopped, choose a server with --address, or set temporal.address in .ugoke/config.yaml\n',
      stdout: "",
    });
    // Both commands end once it stopped, and the script finished before that.
    const stops = { exitCode: 0, stderr: "", stdout: "ugoke daemon: stopped\n" };
    expect(stoppedAgain).toEqual(stops);
    await expect(stopped).resolves.toEqual(stops);
    expect(runEvents()).toContain('"outcome":"succeeded","step":"build","type":"stepFinished"');
    await expect(execute(["daemon", "status"])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "ugoke daemon: not running\n",
    });
  }, 60_000);

  it("warns when the running process uses other options", async () => {
    await start();

    const again = await execute(["daemon", "start", "--address", "localhost:7233"]);

    expect(again).toMatchObject({ exitCode: 0 });
    expect(again.stderr).toMatch(
      /^ugoke daemon: it uses its own development server\. Run "ugoke daemon stop" and start it again to change it\n$/u,
    );
  }, 60_000);

  it("uses the Temporal Server of --address without a Temporal CLI", async () => {
    const environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
    try {
      // Without a development server, the resident process needs no Temporal CLI.
      rmSync(cacheHome(), { force: true, recursive: true });
      const options = ["daemon", "start", "--address", environment.address];

      const started = await execute(options);

      expect(started).toMatchObject({ exitCode: 0 });
      expect(started.stdout).toContain(`server ${environment.address}, `);
      expect(devServers()).toHaveLength(0);
      expect(daemonLog()).not.toContain("downloading Temporal CLI");
      await expect(execute(options)).resolves.toMatchObject({ exitCode: 0, stderr: "" });
      await expect(start()).resolves.toMatchObject({
        exitCode: 0,
        stderr: `ugoke daemon: it uses the server options "--address ${environment.address}". Run "ugoke daemon stop" and start it again to change it\n`,
      });
    } finally {
      // The resident process stops its Workers before the server goes away.
      await execute(["daemon", "stop"]);
      await environment.teardown();
    }
  }, 60_000);

  it("tells how to choose a server when no resident process runs", async () => {
    const run = await new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, "run", "run-success"], {
        cwd: fixtureProject,
        env: { ...process.env, XDG_CACHE_HOME: cacheHome(), XDG_STATE_HOME: state },
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("exit", (exitCode) => resolve({ exitCode, output }));
    });

    expect(run).toEqual({
      exitCode: 1,
      output:
        'run-success: failed: ugoke daemon is not running. Run "ugoke daemon start", choose a server with --address, or set temporal.address in .ugoke/config.yaml\n',
    });
  });
});
