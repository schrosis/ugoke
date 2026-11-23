import confirm from "@inquirer/confirm";

import type { TrustAnswer } from "./trust.js";

/** Streams of a terminal that the question is asked on. */
export interface TrustPromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Asks in a terminal whether to trust the project at a root.
 *
 * Enter alone answers no. Ctrl+C interrupts, and an input that ends before an answer is a no.
 */
export const askTrustInTerminal = async (
  root: string,
  { input, output }: TrustPromptStreams,
): Promise<TrustAnswer> => {
  const closed = new AbortController();
  const close = (): void => closed.abort();
  // The prompt reads keys, and stays unanswered when Ctrl+D closes its input.
  const closeOnEndOfInput = (_text: unknown, key: unknown): void => {
    if (
      typeof key === "object" &&
      key !== null &&
      "ctrl" in key &&
      key.ctrl === true &&
      "name" in key &&
      key.name === "d"
    ) {
      close();
    }
  };
  input.once("end", close);
  input.on("keypress", closeOnEndOfInput);
  try {
    const trusted = await confirm(
      {
        default: false,
        message: `Do you trust the files in ${root}? ugoke reads its configuration and runs its plugins and scripts as you`,
      },
      { input, output, signal: closed.signal },
    );
    return trusted ? "yes" : "no";
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return "interrupted";
    }
    if (error instanceof Error && error.name === "AbortPromptError") {
      return "no";
    }
    throw error;
  } finally {
    input.off("end", close);
    input.off("keypress", closeOnEndOfInput);
  }
};
