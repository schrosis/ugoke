import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import { askTrustInTerminal } from "./trust-prompt.ts";

/** Asks in a terminal where the user types the keys once the question is shown. */
const ask = async (keys: string | undefined) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => {
    shown += chunk.toString();
  });
  const answer = askTrustInTerminal("/work/project", { input, output });
  await new Promise((resolve) => setImmediate(resolve));
  if (keys === undefined) {
    input.end();
  } else {
    input.write(keys);
  }
  return { answer: await answer, shown };
};

describe("askTrustInTerminal", () => {
  it("asks about the root, and tells what ugoke does with it", async () => {
    const { shown } = await ask("y\n");

    // The prompt wraps the question, so the line breaks are removed.
    expect(stripVTControlCharacters(shown).replaceAll("\n", "")).toContain(
      "Do you trust the files in /work/project? ugoke reads its configuration and runs its plugins and scripts as you",
    );
  });

  it("answers yes to y", async () => {
    await expect(ask("y\n")).resolves.toMatchObject({ answer: "yes" });
  });

  it("answers no to n", async () => {
    await expect(ask("n\n")).resolves.toMatchObject({ answer: "no" });
  });

  it("answers no to Enter alone", async () => {
    await expect(ask("\n")).resolves.toMatchObject({ answer: "no" });
  });

  it("is interrupted by Ctrl+C", async () => {
    await expect(ask("\u0003")).resolves.toMatchObject({ answer: "interrupted" });
  });

  it("answers no to Ctrl+D", async () => {
    await expect(ask("\u0004")).resolves.toMatchObject({ answer: "no" });
  });

  it("answers no when the input ends", async () => {
    await expect(ask(undefined)).resolves.toMatchObject({ answer: "no" });
  });
});
