import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { colorsOf, createProgram } from "./program.ts";
import { createOutput, fixtureProject } from "./testing.ts";

const execute = async (args: string[]) => {
  const output = createOutput();
  let exitCode: number | undefined;
  await createProgram({
    cwd: fixtureProject,
    interruptSignal: () => new AbortController().signal,
    prepareEngine: () => {},
    setExitCode: (code) => {
      exitCode = code;
    },
    ...output,
  }).parseAsync(args, { from: "user" });
  return { exitCode, ...output.written };
};

describe("createProgram", () => {
  it("prints the package version", async () => {
    let output = "";
    const program = createProgram({
      cwd: fixtureProject,
      setExitCode: () => {},
      interruptSignal: () => new AbortController().signal,
      prepareEngine: () => {},
      ...createOutput(),
    })
      .exitOverride()
      .configureOutput({ writeOut: (text) => (output += text) });

    await expect(program.parseAsync(["--version"], { from: "user" })).rejects.toMatchObject({
      code: "commander.version",
    });
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({ version: output.trimEnd() });
    expect(output.endsWith("\n")).toBe(true);
  });

  it("lists the commands in groups, starting with init", () => {
    const help = createProgram({
      cwd: fixtureProject,
      setExitCode: () => {},
      interruptSignal: () => new AbortController().signal,
      prepareEngine: () => {},
      ...createOutput(),
    }).helpInformation();

    const listed = [...help.matchAll(/^(\S.*:|  [a-z]+)/gmu)].map(([line]) => line.trim());
    expect(listed.slice(listed.indexOf("Getting started:"))).toEqual([
      "Getting started:",
      "init",
      "help",
      "Run workflows:",
      "run",
      "attach",
      "cancel",
      "inbox",
      "log",
      "Write workflows:",
      "validate",
      "schema",
      "docs",
      "Background:",
      "daemon",
    ]);
  });

  it.each([
    ["run", "run-direct"],
    ["attach"],
    ["cancel"],
    ["inbox", "list"],
    ["inbox", "answer", "run-1", "--step", "approve", "--values", "{}", "--detach"],
    ["log", "run-1"],
    ["validate", "run-direct"],
    ["schema"],
    ["docs", "run-direct"],
  ])("asks whether to trust the project before ugoke %s reads it", async (...args) => {
    const output = createOutput();
    const asked: string[] = [];
    let exitCode: number | undefined;

    await createProgram({
      askTrust: async (root) => {
        asked.push(root);
        return Promise.resolve("no");
      },
      cwd: fixtureProject,
      interruptSignal: () => new AbortController().signal,
      prepareEngine: () => {},
      setExitCode: (code) => {
        exitCode = code;
      },
      trustStore: { add: () => {}, has: () => false },
      ...output,
    }).parseAsync(args, { from: "user" });

    expect(asked).toEqual([fixtureProject]);
    expect(exitCode).toBe(1);
    expect(output.written).toEqual({
      stderr: `ugoke: ${fixtureProject} is not trusted, so nothing in it was read\n`,
      stdout: "",
    });
  });

  it("goes on with the command after the user trusts the project", async () => {
    const output = createOutput();
    const added: string[] = [];
    let exitCode: number | undefined;

    await createProgram({
      askTrust: async () => Promise.resolve("yes"),
      cwd: fixtureProject,
      interruptSignal: () => new AbortController().signal,
      prepareEngine: () => {},
      setExitCode: (code) => {
        exitCode = code;
      },
      trustStore: { add: (root) => added.push(root), has: () => false },
      ...output,
    }).parseAsync(["validate", "run-direct"], { from: "user" });

    expect(added).toEqual([fixtureProject]);
    expect(exitCode).toBe(0);
    expect(output.written.stdout).toBe("run-direct: valid\n");
  });

  it("exits with zero when validate succeeds", async () => {
    await expect(execute(["validate", "valid"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "valid: valid\n",
    });
  });

  it("exits with one when validate fails", async () => {
    await expect(execute(["validate", "transition-error"])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    });
  });
});

describe("colorsOf", () => {
  const forceColor = process.env.FORCE_COLOR;

  afterEach(() => {
    if (forceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = forceColor;
    }
  });

  it("does not detach a run on a server that ugoke daemon may not run", async () => {
    let error = "";
    const program = createProgram({
      cwd: fixtureProject,
      interruptSignal: () => new AbortController().signal,
      prepareEngine: () => {},
      setExitCode: () => {},
      ...createOutput(),
    })
      .exitOverride()
      .configureOutput({ writeErr: (text) => (error += text) });
    const run = program.commands.find((command) => command.name() === "run");
    run?.exitOverride().configureOutput({ writeErr: (text) => (error += text) });

    await expect(
      program.parseAsync(["run", "valid", "--detach", "--address", "localhost:7233"], {
        from: "user",
      }),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
    expect(error).toContain("option '--detach' cannot be used with option");
  });

  it("asks a terminal whether it has colors", () => {
    expect(colorsOf({ hasColors: () => true, isTTY: true })).toBe(true);
    expect(colorsOf({ hasColors: () => false, isTTY: true })).toBe(false);
  });

  it("colors another stream only when FORCE_COLOR asks for it", () => {
    delete process.env.FORCE_COLOR;
    expect(colorsOf({})).toBe(false);

    process.env.FORCE_COLOR = "1";
    expect(colorsOf({})).toBe(true);

    process.env.FORCE_COLOR = "0";
    expect(colorsOf({})).toBe(false);
  });
});
