import { PassThrough } from "node:stream";

import {
  decimalNumberMessage,
  decimalNumberPattern,
  defineWaitMethod,
  definePlugin,
  inputDeclarationsSchema,
} from "@ugoke/core";
import type { InputDeclaration, WaitMethod, WaitResponseContext } from "@ugoke/core";
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import select from "@inquirer/select";
import { z } from "zod";

import { enableKittyKeyboard, supportsKittyKeyboard } from "./keyboard.js";
import { multilinePrompt } from "./multiline.js";

/** Options of the `terminal` wait method, as the `with` field of a step writes them. */
const optionsSchema = z.strictObject({
  message: z.string().min(1).describe("Message that the terminal shows before asking"),
  schema: inputDeclarationsSchema
    .default({})
    .describe("Values to ask for. Without it, the step waits until Enter is pressed"),
});

/** Options of the `terminal` wait method. */
export type TerminalOptions = z.infer<typeof optionsSchema>;

/** Streams of a terminal where someone presses keys, which interactive prompts ask in. */
export interface TerminalStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /**
   * Interrupts the command, as Ctrl+C does elsewhere. A prompt reads Ctrl+C as a key, so the
   * terminal does not send SIGINT while it asks.
   */
  interrupt: () => void;
}

/** The terminal that the method asks in. */
export interface TerminalIO {
  /** Writes text without adding a newline. */
  write: (text: string) => void;
  /**
   * Reads the next line without its line ending.
   *
   * @returns The line, or `null` when the input ends.
   */
  readLine: (signal: AbortSignal) => Promise<string | null>;
  /**
   * Returns the streams to ask in with interactive prompts, such as a list to choose from.
   *
   * It returns `undefined` when the input or the output is not a terminal, such as when a script
   * answers through a pipe. The method then reads lines with {@link TerminalIO.readLine}.
   */
  interactive?: () => TerminalStreams | undefined;
}

/**
 * Result of {@link parseAnswer}. A missing value means that the answer is not given, and the
 * workflow uses `null` for it.
 */
type Parsed = { ok: true; value?: boolean | number | string } | { ok: false; message: string };

const trueWords = new Set(["y", "yes", "true"]);
const falseWords = new Set(["n", "no", "false"]);

/**
 * Parses a line that answers a declaration.
 *
 * An empty line uses the default. Without a default, it leaves an optional answer not given,
 * because the workflow accepts only values of the declared type.
 */
export const parseAnswer = (declaration: InputDeclaration, line: string): Parsed => {
  const text = declaration.type === "string" ? line : line.trim();
  if (text === "") {
    if (declaration.default !== undefined) {
      return { ok: true, value: declaration.default };
    }
    return declaration.required ? { message: "A value is required", ok: false } : { ok: true };
  }
  if (declaration.type === "string") {
    return { ok: true, value: text };
  }
  if (declaration.type === "number") {
    return decimalNumberPattern.test(text)
      ? { ok: true, value: Number(text) }
      : { message: decimalNumberMessage, ok: false };
  }
  if (declaration.type === "boolean") {
    const word = text.toLowerCase();
    if (trueWords.has(word)) {
      return { ok: true, value: true };
    }
    return falseWords.has(word)
      ? { ok: true, value: false }
      : { message: "Enter y or n", ok: false };
  }
  return declaration.options.includes(text)
    ? { ok: true, value: text }
    : { message: `Enter one of ${declaration.options.join(", ")}`, ok: false };
};

/** Returns whether a declaration asks for text that can span lines. */
const isMultiline = (declaration: InputDeclaration): boolean =>
  declaration.type === "string" && declaration.multiline === true;

/** A line that ends a multiline answer that is read line by line. */
export const endOfMultiline = ".";

/**
 * Formats the prompt of a declaration, such as `approve (y/n, required): `.
 *
 * A multiline answer is entered on the lines after the prompt, so its prompt ends with a newline.
 */
export const formatPrompt = (name: string, declaration: InputDeclaration): string => {
  const kind =
    declaration.type === "boolean"
      ? "y/n"
      : declaration.type === "choice"
        ? declaration.options.join("/")
        : declaration.type;
  const details = [
    kind,
    ...(isMultiline(declaration) ? ["multiline"] : []),
    ...(declaration.required ? ["required"] : []),
    ...(declaration.default === undefined ? [] : [`default: ${String(declaration.default)}`]),
  ];
  const description = declaration.description === undefined ? "" : ` ${declaration.description}`;
  const prompt = `${name}${description} (${details.join(", ")})`;
  return isMultiline(declaration)
    ? `${prompt}. End with a line of "${endOfMultiline}":\n`
    : `${prompt}: `;
};

const inputEnded = (): Error => new Error("The input ended before the answer was entered");

/** Options of {@link createTerminalPlugin}. */
export interface TerminalPluginOptions {
  /**
   * Whether the method writes `message` before it asks. Turn it off when the progress of the
   * run already shows the message of the step.
   */
  showMessage?: boolean;
}

/**
 * Reads the answer of a declaration line by line, as a script answers through a pipe.
 *
 * @returns The text to parse, which spans lines for a multiline answer.
 */
const readText = async (
  { readLine }: TerminalIO,
  declaration: InputDeclaration,
  signal: AbortSignal,
): Promise<string> => {
  if (!isMultiline(declaration)) {
    const line = await readLine(signal);
    if (line === null) {
      throw inputEnded();
    }
    return line;
  }
  const lines: string[] = [];
  for (;;) {
    const line = await readLine(signal);
    if (line === null) {
      throw inputEnded();
    }
    if (line === endOfMultiline) {
      return lines.join("\n");
    }
    lines.push(line);
  }
};

const askLineByLine = async (
  io: TerminalIO,
  entries: readonly [string, InputDeclaration][],
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  const { readLine, write } = io;
  if (entries.length === 0) {
    write("Press Enter to continue: ");
    if ((await readLine(signal)) === null) {
      throw inputEnded();
    }
    return {};
  }

  const values: Record<string, unknown> = {};
  for (const [name, declaration] of entries) {
    for (;;) {
      write(formatPrompt(name, declaration));
      const parsed = parseAnswer(declaration, await readText(io, declaration, signal));
      if (parsed.ok) {
        if (parsed.value !== undefined) {
          values[name] = parsed.value;
        }
        break;
      }
      write(`${parsed.message}\n`);
    }
  }
  return values;
};

/** Value of the choice that leaves an optional answer not given. */
const skip: unique symbol = Symbol("skip");

/** Streams and the signal of a single prompt. */
interface PromptContext {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  signal: AbortSignal;
}

/**
 * Asks for an answer that can span lines in the terminal itself.
 *
 * Shift+Enter starts a new line only in a terminal with the kitty keyboard protocol, which is on
 * only while the prompt asks.
 */
const askMultiline = async (
  message: string,
  declaration: Extract<InputDeclaration, { type: "string" }>,
  streams: TerminalStreams,
  context: PromptContext,
  validate: (text: string) => string | true,
): Promise<string> => {
  const shiftEnter = await supportsKittyKeyboard(streams.input, streams.output);
  const disable = shiftEnter ? enableKittyKeyboard(streams.output) : () => {};
  try {
    return await multilinePrompt(
      {
        default: declaration.default,
        interrupt: streams.interrupt,
        message,
        shiftEnter,
        validate,
      },
      context,
    );
  } finally {
    disable();
  }
};

/** Asks for the answer of a declaration with an interactive prompt. */
const askInteractively = async (
  name: string,
  declaration: InputDeclaration,
  streams: TerminalStreams,
  signal: AbortSignal,
): Promise<boolean | number | string | undefined> => {
  const context = createPromptContext(streams, signal);
  const message =
    declaration.description === undefined ? name : `${name} ${declaration.description}`;
  const parse = (text: string): boolean | number | string | undefined => {
    const parsed = parseAnswer(declaration, text);
    if (!parsed.ok) {
      // The prompt validates the answer before it returns it.
      throw new Error(parsed.message);
    }
    return parsed.value;
  };
  const validate = (text: string): string | true => {
    const parsed = parseAnswer(declaration, text);
    return parsed.ok || parsed.message;
  };

  if (declaration.type === "choice") {
    const choices: { name?: string; value: string | typeof skip }[] = declaration.options.map(
      (option) => ({ value: option }),
    );
    if (!declaration.required && declaration.default === undefined) {
      choices.push({ name: "(skip)", value: skip });
    }
    const chosen = await select(
      {
        choices,
        ...(declaration.default === undefined ? {} : { default: declaration.default }),
        message,
      },
      context,
    );
    return chosen === skip ? undefined : chosen;
  }
  if (declaration.type === "boolean" && declaration.default !== undefined) {
    // Without a default, Enter alone would answer yes, so the answer is typed instead.
    return confirm({ default: declaration.default, message }, context);
  }
  if (declaration.type === "string" && declaration.multiline === true) {
    return parse(await askMultiline(message, declaration, streams, context, validate));
  }
  const kind = declaration.type === "boolean" ? "y/n" : declaration.type;
  const text = await input(
    {
      default: declaration.default === undefined ? undefined : String(declaration.default),
      message: `${message} (${kind})`,
      validate,
    },
    context,
  );
  return parse(text);
};

/** Rejects when the signal is aborted. */
const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** Returns whether a prompt ended because Ctrl+C was pressed. */
const isExitPrompt = (error: unknown): boolean =>
  error instanceof Error && error.name === "ExitPromptError";

/**
 * Creates the context of a single prompt.
 *
 * A prompt ends its output when it is done, so each prompt writes to its own stream, which
 * passes the text on without ending the output of the terminal.
 */
const createPromptContext = (
  { input: keys, output }: TerminalStreams,
  signal: AbortSignal,
): PromptContext => {
  const own = new PassThrough();
  own.pipe(output, { end: false });
  // The prompts wrap their lines to the width of the terminal.
  Object.defineProperty(own, "columns", { get: () => Reflect.get(output, "columns") as unknown });
  return { input: keys, output: own, signal };
};

const askWithPrompts = async (
  streams: TerminalStreams,
  entries: readonly [string, InputDeclaration][],
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  try {
    if (entries.length === 0) {
      await input({ message: "Press Enter to continue" }, createPromptContext(streams, signal));
      return {};
    }
    const values: Record<string, unknown> = {};
    for (const [name, declaration] of entries) {
      const value = await askInteractively(name, declaration, streams, signal);
      if (value !== undefined) {
        values[name] = value;
      }
    }
    return values;
  } catch (error) {
    if (isExitPrompt(error)) {
      // The command decides what Ctrl+C does, such as detaching the run, and aborts the signal.
      streams.interrupt();
      return untilAborted(signal);
    }
    // A prompt that the interrupt of the command aborted ends with the reason of the signal.
    if (signal.aborted) {
      return untilAborted(signal);
    }
    throw error;
  }
};

const respond =
  (io: TerminalIO, { showMessage = true }: TerminalPluginOptions) =>
  async ({
    answers,
    options,
    signal,
  }: WaitResponseContext<TerminalOptions>): Promise<Record<string, unknown>> => {
    if (showMessage) {
      io.write(`${options.message}\n`);
    }
    const entries = Object.entries(answers);
    const streams = io.interactive?.();
    return streams === undefined
      ? askLineByLine(io, entries, signal)
      : askWithPrompts(streams, entries, signal);
  };

const createMethod = (
  io?: TerminalIO,
  options: TerminalPluginOptions = {},
): WaitMethod<TerminalOptions> =>
  defineWaitMethod({
    answers: ({ schema }) => schema,
    name: "terminal",
    ...(io === undefined ? {} : { respond: respond(io, options) }),
    with: optionsSchema,
  });

/**
 * Waits for an answer that someone enters in the terminal of `ugoke run`.
 *
 * The answers are the values that `schema` declares. This instance only validates definitions;
 * use {@link createTerminalPlugin} to answer.
 */
export const terminalWaitMethod = createMethod();

/** The built-in plugin that provides the `terminal` wait method, for validating definitions. */
export const terminalPlugin = definePlugin({
  name: "terminal",
  waitMethods: [terminalWaitMethod],
});

/** Creates the built-in plugin of the `terminal` wait method that asks in a terminal. */
export const createTerminalPlugin = (io: TerminalIO, options: TerminalPluginOptions = {}) =>
  definePlugin({ name: "terminal", waitMethods: [createMethod(io, options)] });
