import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createOutput, fixtureProject } from "../testing.ts";
import { run } from "./run.ts";

describe("run", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const execute = async (
    name: string,
    signal = new AbortController().signal,
    onStdout: (text: string) => void = () => {},
    input?: string,
    stdin = "",
  ) => {
    const output = createOutput();
    const exitCode = await run(
      name,
      {
        input,
        server: { address: environment.address, type: "address" },
        signal,
        version: "0.0.0",
      },
      {
        cwd: fixtureProject,
        stderr: output.stderr,
        stdin: () => Readable.from([stdin]),
        stdout: (text) => {
          output.stdout(text);
          onStdout(text);
        },
      },
    );
    return { exitCode, ...output.written };
  };

  it("runs the steps in the project root", async () => {
    const result = await execute("run-success");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toMatch(
      /^check\n│ > test -d \.ugoke\n✓ check {2}\d+\.\ds\n\nfinish\n│ > true\n✓ finish {2}\d+\.\ds\n\nrun-success: completed \(check, finish\)\n$/u,
    );
  }, 60_000);

  it("shows script output as it runs", async () => {
    const result = await execute("run-output");

    expect(result).toMatchObject({ exitCode: 0, stderr: "│ fuga\n" });
    expect(result.stdout).toMatch(
      /^firstStep\n│ > echo "hoge"\n│ hoge\n✓ firstStep {2}\d+\.\ds\n\nsecondStep\n│ > echo "fuga" >&2\n✓ secondStep {2}\d+\.\ds\n\nrun-output: completed \(firstStep, secondStep\)\n$/u,
    );
  }, 60_000);

  it("passes values between steps", async () => {
    const result = await execute("run-values");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain(
      '│ > test "hello" = hello && echo "title=hello"\n│ title=hello\n',
    );
  }, 60_000);

  it("passes the workflow input with defaults applied", async () => {
    const result = await execute("run-input", undefined, undefined, '{"level": "high"}');

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("threshold=1.5 level=high note=[]\n");
  }, 60_000);

  it("reports invalid workflow input without starting the workflow", async () => {
    await expect(
      execute("run-input", undefined, undefined, '{"level": "mid", "extra": 1}'),
    ).resolves.toEqual({
      exitCode: 1,
      stderr:
        "run-input: workflow.inputs.extra: Unknown input\nrun-input: workflow.inputs.level: Must be one of low, high\n",
      stdout: "",
    });
  }, 60_000);

  it("expands the workflow input and earlier outputs in run and output directly", async () => {
    const result = await execute("run-direct", undefined, undefined, '{"name": "ugoke"}');

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Hello ugoke!!\n");
    expect(result.stdout).toContain("│ > echo 'report-Hello ugoke!!'\n│ report-Hello ugoke!!\n");
  }, 60_000);

  it("rejects workflow input over the size limit without starting the workflow", async () => {
    const note = "x".repeat(600 * 1024);
    await expect(
      execute("run-input", undefined, undefined, JSON.stringify({ level: "high", note })),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: expect.stringMatching(
        /^run-input: workflow\.inputs is \d+ bytes, which exceeds the limit of 524288 bytes\n$/u,
      ) as unknown,
      stdout: "",
    });
  }, 60_000);

  it("reports unreadable workflow input", async () => {
    await expect(execute("run-input", undefined, undefined, "input.yaml")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "run-input: --input must be a JSON object or the path of a .json file: input.yaml\n",
    });
  }, 60_000);

  it("asks the answers of a wait step and passes them on", async () => {
    const result = await execute(
      "wait-valid",
      undefined,
      undefined,
      undefined,
      "schrosis\nmaybe\ny\n",
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toMatch(
      /^ask\n│ > Hello, what is your name\?\nname \(string, required\): schrosis\napprove \(y\/n\): maybe\nEnter y or n\napprove \(y\/n\): y\n✓ ask {2}\d+\.\ds\n\ngreet\n│ > echo "Hello schrosis!!"\n│ Hello schrosis!!\n/u,
    );
  }, 60_000);

  it("accepts an empty optional answer without asking again", async () => {
    const result = await execute("wait-valid", undefined, undefined, undefined, "schrosis\n\n");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("name (string, required): schrosis\napprove (y/n): \n✓ ask  ");
  }, 60_000);

  it("fails when the input ends before the answers", async () => {
    await expect(execute("wait-valid")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "wait-valid: failed: The input ended before the answer was entered\n",
    });
  }, 60_000);

  it("passes values through env and dotenv without running them", async () => {
    const result = await execute("run-env");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain(
      "title=['; echo injected; echo '] level=info port=3000 dotenv=dotenv overridden=from-workflow home-kept=yes\n",
    );
    expect(result.stdout).not.toMatch(/^injected$/mu);
  }, 60_000);

  it("takes the first branch that holds, and reads a step that did not run as empty", async () => {
    const result = await execute("run-branch");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("run-branch: completed (check, matched, join)\n");
    expect(result.stdout).toContain("other=[]\n");
  }, 60_000);

  it.each([
    ["y\n", "run-branch-wait: completed (ask, continued)\n"],
    ["n\n", "run-branch-wait: completed (ask)\n"],
  ])(
    "chooses a branch of a wait step for %j",
    async (answers, completed) => {
      const result = await execute("run-branch-wait", undefined, undefined, undefined, answers);

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain(completed);
    },
    60_000,
  );

  it("asks a wait step again when a loop comes back to it", async () => {
    const result = await execute("run-loop-wait", undefined, undefined, undefined, "y\ny\nn\n");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("run-loop-wait: completed (ask, ask, ask)\n");
  }, 60_000);

  it("reports a failed script", async () => {
    const result = await execute("run-failure");

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: "run-failure: failed: Script exited with code 3\n",
    });
    expect(result.stdout).toMatch(
      /^fail\n│ > exit 3\n✗ fail {2}Script exited with code 3 · \d+\.\ds\n\n$/u,
    );
  }, 60_000);

  it("detaches when interrupted, after the running script finishes", async () => {
    const controller = new AbortController();
    // Interrupt once the script has started, because starting a Worker can take a while in CI.
    const result = await execute("run-detach", controller.signal, (text) => {
      if (text.startsWith("build\n")) {
        controller.abort();
      }
    });

    expect(result).toMatchObject({ exitCode: 3 });
    expect(result.stdout).toMatch(
      /^build\n│ > sleep 2 && echo built\n\n│ built\n✓ build {2}\d+\.\ds\n\n$/u,
    );
    expect(result.stderr).toBe(
      [
        "Waiting for the running step to finish, so that you can attach to the run later.",
        "Press Ctrl+C again to exit now. The running step will fail, and the run cannot be continued.",
        `run-detach: detached. Run "ugoke attach --address ${environment.address}" to continue`,
        "",
      ].join("\n"),
    );
  }, 60_000);

  it("does not start an invalid workflow", async () => {
    await expect(execute("transition-error")).resolves.toMatchObject({ exitCode: 1, stdout: "" });
  }, 60_000);

  it("runs on the Temporal Server that the configuration file of the project names", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-configured-")));
    try {
      mkdirSync(join(root, ".ugoke", "workflows"), { recursive: true });
      writeFileSync(
        join(root, ".ugoke", "config.yaml"),
        `temporal:\n  address: ${environment.address}\n`,
      );
      writeFileSync(
        join(root, ".ugoke", "workflows", "hello.yaml"),
        "version: v0.1\nstart: hello\nsteps:\n  hello:\n    type: script\n    run: echo hello\n    next: end\n",
      );
      const output = createOutput();

      // No resident process runs in the state directory of the tests.
      const exitCode = await run(
        "hello",
        { signal: new AbortController().signal, version: "0.0.0" },
        { cwd: root, ...output },
      );

      expect(exitCode).toBe(0);
      expect(output.written.stdout).toContain("hello: completed (hello)\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
