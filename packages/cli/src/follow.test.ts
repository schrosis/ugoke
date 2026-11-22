import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { CommandContext } from "./commands/load.ts";
import { createTerminal, followRun } from "./follow.ts";
import type { OpenedServer } from "./server.ts";
import { fixtureProject } from "./testing.ts";

const createContext = (
  stdin: NodeJS.ReadableStream,
  overrides: Partial<CommandContext> = {},
): CommandContext & { written: () => string } => {
  let written = "";
  return {
    columns: () => 100,
    cwd: "/",
    interrupt: () => {},
    stderr: () => {},
    stdin: () => stdin,
    stdout: (text) => {
      written += text;
    },
    written: () => written,
    ...overrides,
  };
};

const terminalInput = (): PassThrough => Object.assign(new PassThrough(), { isTTY: true });

describe("createTerminal", () => {
  it("asks with prompts when standard input and output are terminals", () => {
    const context = createContext(terminalInput());
    const streams = createTerminal(context).interactive?.();

    expect(streams).toBeDefined();
    expect(streams?.output).toHaveProperty("columns", 100);
    streams?.output.write("? name");
    expect(context.written()).toBe("? name");
  });

  it.each<[string, Partial<CommandContext>, NodeJS.ReadableStream]>([
    ["standard input is a pipe", {}, Readable.from(["y\n"])],
    ["standard output is not a terminal", { columns: undefined }, terminalInput()],
    ["the command cannot be interrupted", { interrupt: undefined }, terminalInput()],
  ])("reads lines when %s", (_name, overrides, stdin) => {
    expect(createTerminal(createContext(stdin, overrides)).interactive?.()).toBeUndefined();
  });

  it("reads lines again after a prompt", async () => {
    const input = terminalInput();
    const terminal = createTerminal(createContext(input));
    const signal = new AbortController().signal;

    const first = terminal.readLine(signal);
    input.write("1\n");
    await expect(first).resolves.toBe("1");
    terminal.interactive?.();
    const second = terminal.readLine(signal);
    input.write("2\n");

    await expect(second).resolves.toBe("2");
    terminal.close();
  });
});

/** A server that the command connected to. */
const server: OpenedServer = { address: "127.0.0.1:7233", options: " --address 127.0.0.1:7233" };

describe("followRun", () => {
  it("prepares the engine right before it follows the run", async () => {
    const calls: string[] = [];
    const exitCode = await followRun(
      {
        follow: async () => {
          calls.push("follow");
          return { executedSteps: ["check"], status: "completed", workflowId: "run-1" };
        },
        interrupt: new AbortController().signal,
        name: "run-success",
        prepareEngine: () => calls.push("prepareEngine"),
        root: fixtureProject,
        server,
      },
      createContext(Readable.from([])),
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["prepareEngine", "follow"]);
  });

  it("reads the encryption key before it prepares the engine, which keeps the process alive", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-key-")));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = base;
    try {
      mkdirSync(join(base, "ugoke"), { mode: 0o700 });
      writeFileSync(join(base, "ugoke", "encryption.key"), "broken\n", { mode: 0o600 });
      const calls: string[] = [];
      let errors = "";

      const exitCode = await followRun(
        {
          follow: async () => {
            calls.push("follow");
            return { executedSteps: [], status: "completed", workflowId: "run-1" };
          },
          interrupt: new AbortController().signal,
          name: "run-success",
          prepareEngine: () => calls.push("prepareEngine"),
          root: fixtureProject,
          server,
        },
        createContext(Readable.from([]), {
          stderr: (text) => {
            errors += text;
          },
        }),
      );

      expect(exitCode).toBe(1);
      expect(calls).toEqual([]);
      expect(errors).toContain("run-success: failed: The encryption key in");
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previous;
      }
      rmSync(base, { force: true, recursive: true });
    }
  });
});
