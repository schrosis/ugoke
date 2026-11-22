import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { fixtureProject } from "./testing.ts";

interface ExecuteOptions {
  env?: NodeJS.ProcessEnv;
  onOutput?: (child: ChildProcess, output: string) => void;
  timeoutMs?: number;
}

// These tests run the built executable, so they depend on `pnpm build`.
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/**
 * Runs the executable and reports whether it exits by itself.
 *
 * @param onOutput Receives the child process and the output so far, such as to interrupt it.
 */
const execute = async (
  args: string[],
  cwd: string,
  { env = process.env, onOutput = () => {}, timeoutMs = 10_000 }: ExecuteOptions = {},
) =>
  new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      onOutput(child, output);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      onOutput(child, output);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ugoke ${args.join(" ")} did not exit: ${output}`));
    }, timeoutMs);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });

describe("ugoke executable", () => {
  let outside: string;

  beforeAll(() => {
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-no-project-")));
  });

  afterAll(() => {
    rmSync(outside, { force: true, recursive: true });
  });

  it.each([
    ["validate", "missing"],
    ["run", "missing"],
  ])(
    "exits after %s fails outside a project",
    async (...args) => {
      const { exitCode, output } = await execute(args, outside);

      expect(exitCode, output).toBe(1);
    },
    20_000,
  );

  it("exits when the Temporal Server cannot be reached", async () => {
    // Port 1 is reserved and nothing listens on it.
    const { exitCode, output } = await execute(
      ["run", "valid", "--address", "127.0.0.1:1"],
      fixtureProject,
    );

    expect(exitCode, output).toBe(1);
  }, 20_000);

  it("exits after validate succeeds", async () => {
    await expect(execute(["validate", "valid"], fixtureProject)).resolves.toEqual({
      exitCode: 0,
      output: "valid: valid\n",
    });
  }, 20_000);

  describe("with a Temporal Server", () => {
    let environment: TestWorkflowEnvironment;
    let server: string[];

    beforeAll(async () => {
      environment = await TestWorkflowEnvironment.createLocal({
        server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
      });
      server = ["--address", environment.address];
    }, 60_000);

    afterAll(async () => {
      await environment.teardown();
    });

    it("runs a workflow", async () => {
      const { exitCode, output } = await execute(
        ["run", "run-success", ...server],
        fixtureProject,
        {
          timeoutMs: 30_000,
        },
      );

      expect(exitCode, output).toBe(0);
      expect(output).toContain("run-success: completed (check, finish)\n");
    }, 40_000);

    it("detaches the run when interrupted while waiting", async () => {
      let interrupted = false;
      const { exitCode, output } = await execute(["run", "wait-valid", ...server], fixtureProject, {
        onOutput: (child, text) => {
          if (!interrupted && text.includes("name (string, required): ")) {
            interrupted = true;
            child.kill("SIGINT");
          }
        },
        timeoutMs: 30_000,
      });

      expect(exitCode, output).toBe(3);
      expect(output).toContain(
        `wait-valid: detached. Run "ugoke attach --address ${environment.address}" to continue\n`,
      );
    }, 40_000);

    it("exits at once when interrupted twice", async () => {
      let interrupts = 0;
      const { exitCode, output } = await execute(["run", "run-sleep", ...server], fixtureProject, {
        onOutput: (child, text) => {
          // Two signals sent at once can arrive as one, so the second waits for the first.
          if (interrupts === 0 && text.includes("wait\n│ > sleep 30")) {
            interrupts = 1;
            child.kill("SIGINT");
          } else if (interrupts === 1 && text.includes("Press Ctrl+C again to exit now")) {
            interrupts = 2;
            child.kill("SIGINT");
          }
        },
        timeoutMs: 20_000,
      });

      expect(exitCode, output).toBe(130);
    }, 30_000);
  });

  it.each([
    ["run", "valid", "--dev"],
    ["attach", "--dev-db", "state.db"],
    ["cancel", "--temporal-bin", "temporal"],
    ["run", "valid", "--dev-ui"],
    ["daemon", "start", "--dev-db", "state.db"],
    ["daemon", "start", "--temporal-bin", "temporal"],
    ["daemon", "start", "--dev-ui"],
  ])(
    "rejects the removed server options of %s",
    async (...args) => {
      const { exitCode, output } = await execute(args, fixtureProject);

      expect(exitCode, output).toBe(1);
      expect(output).toContain("unknown option");
    },
    20_000,
  );
});

describe("ugoke with an unsafe state directory", () => {
  it("explains the problem without a stack trace", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-state-")));
    try {
      mkdirSync(join(base, "ugoke"), { mode: 0o755 });
      chmodSync(join(base, "ugoke"), 0o755);

      const result = await execute(["daemon", "status"], base, {
        env: { ...process.env, XDG_STATE_HOME: base },
      });

      expect(result).toEqual({
        exitCode: 1,
        output: `ugoke: Other users can use the state directory ${join(base, "ugoke")}. Run "chmod 700 ${join(base, "ugoke")}" to fix it\n`,
      });
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });
});

describe("ugoke with a broken encryption key", () => {
  it("exits when a run cannot start", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-state-")));
    try {
      mkdirSync(join(base, "ugoke"), { mode: 0o700 });
      writeFileSync(join(base, "ugoke", "encryption.key"), "broken\n", { mode: 0o600 });

      // Port 1 is reserved, so the run fails at the key before it reaches a server.
      const { exitCode, output } = await execute(
        ["run", "valid", "--address", "127.0.0.1:1"],
        fixtureProject,
        { env: { ...process.env, XDG_STATE_HOME: base } },
      );

      expect(exitCode, output).toBe(1);
      expect(output).toContain("The encryption key in");
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  }, 20_000);
});
