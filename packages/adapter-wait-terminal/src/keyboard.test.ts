import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { enableKittyKeyboard, supportsKittyKeyboard } from "./keyboard.ts";

/** A terminal that answers the queries that it receives with the given text. */
const createTerminal = (answer: string | undefined, isTTY = true) => {
  let raw = false;
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    isTTY,
    setRawMode: (mode: boolean) => {
      raw = mode;
    },
  });
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
    if (answer !== undefined) {
      input.write(answer);
    }
  });
  return { input, isRaw: () => raw, output, written: () => written };
};

describe("supportsKittyKeyboard", () => {
  it("is true for a terminal that answers the flags before the attributes", async () => {
    const { input, isRaw, output } = createTerminal("\u001B[?1u\u001B[?62c");

    await expect(supportsKittyKeyboard(input, output)).resolves.toBe(true);
    expect(isRaw()).toBe(false);
  });

  it("is false for a terminal that answers only the attributes", async () => {
    const { input, output } = createTerminal("\u001B[?62;22c");

    await expect(supportsKittyKeyboard(input, output)).resolves.toBe(false);
  });

  it("is false for a terminal that answers nothing in time", async () => {
    const { input, output } = createTerminal(undefined);

    await expect(supportsKittyKeyboard(input, output, 10)).resolves.toBe(false);
  });

  it("asks nothing of an input that is not a terminal", async () => {
    const { input, output, written } = createTerminal("\u001B[?1u\u001B[?62c", false);

    await expect(supportsKittyKeyboard(input, output)).resolves.toBe(false);
    expect(written()).toBe("");
  });
});

describe("enableKittyKeyboard", () => {
  it("turns the protocol on, and off once", () => {
    const { output, written } = createTerminal(undefined);

    const disable = enableKittyKeyboard(output);
    disable();
    disable();

    expect(written()).toBe("\u001B[>1u\u001B[<u");
  });

  it("turns the protocol off when the process exits", () => {
    const { output, written } = createTerminal(undefined);

    enableKittyKeyboard(output);
    process.emit("exit", 0);

    expect(written()).toBe("\u001B[>1u\u001B[<u");
  });
});
