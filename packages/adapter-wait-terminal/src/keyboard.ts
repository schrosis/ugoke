/**
 * Sequences of the kitty keyboard protocol that a multiline prompt reads, which a terminal sends
 * only while the protocol is on.
 *
 * See https://sw.kovidgoyal.net/kitty/keyboard-protocol/.
 */
export const kittyKeys = {
  altEnter: "\u001B[13;3u",
  ctrlC: "\u001B[99;5u",
  shiftEnter: "\u001B[13;2u",
} as const;

/** Asks the terminal for its flags of the kitty keyboard protocol, and then for its attributes. */
const query = "\u001B[?u\u001B[c";

/** Start of the answers to both queries. */
const answerStart = "\u001B[?";

/** Characters of the numbers in the answers. */
const answerDigits = "0123456789;";

/** An answer to a query, found in what the terminal sent. */
interface Answer {
  start: number;
  end: number;
  /** The last character, which is `u` for the flags and `c` for the attributes. */
  kind: string;
}

/** Finds the answers to the queries in what the terminal sent. */
const findAnswers = (text: string): Answer[] => {
  const answers: Answer[] = [];
  for (
    let start = text.indexOf(answerStart);
    start !== -1;
    start = text.indexOf(answerStart, start + 1)
  ) {
    let index = start + answerStart.length;
    while (index < text.length && answerDigits.includes(text.charAt(index))) {
      index += 1;
    }
    const kind = text.charAt(index);
    if (kind === "u" || kind === "c") {
      answers.push({ end: index + 1, kind, start });
    }
  }
  return answers;
};

/** Returns what the terminal sent without the answers, which is what someone typed meanwhile. */
const withoutAnswers = (text: string, answers: readonly Answer[]): string => {
  let rest = "";
  let from = 0;
  for (const { end, start } of answers) {
    rest += text.slice(from, start);
    from = end;
  }
  return rest + text.slice(from);
};

/**
 * Time to wait for the answers of a terminal that answers neither query.
 *
 * Almost every terminal answers the attributes at once, so the wait ends earlier. It is long
 * enough for a terminal behind SSH or tmux, whose late answer would otherwise reach the prompt as
 * keys.
 */
const defaultTimeoutMs = 1000;

/** A stream of keys that can be a terminal. */
type KeyInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  unshift?: (chunk: string) => void;
};

/**
 * Returns whether the terminal supports the kitty keyboard protocol.
 *
 * It asks for the flags of the protocol and then for the attributes of the terminal, which almost
 * every terminal answers. A terminal that answers the attributes without the flags lacks the
 * protocol. The answers are read as data, not as keys, so that they never reach a prompt, and
 * keys that someone types meanwhile are given back to the input.
 */
export const supportsKittyKeyboard = async (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  timeoutMs = defaultTimeoutMs,
): Promise<boolean> => {
  const keys = input as KeyInput;
  if (keys.isTTY !== true) {
    return false;
  }
  const wasRaw = keys.isRaw === true;
  keys.setRawMode?.(true);
  return new Promise((resolve) => {
    let received = "";
    const finish = (supported: boolean): void => {
      clearTimeout(timer);
      input.removeListener("data", onData);
      const typed = withoutAnswers(received, findAnswers(received));
      if (typed !== "") {
        keys.unshift?.(typed);
      }
      keys.setRawMode?.(wasRaw);
      input.pause();
      resolve(supported);
    };
    const onData = (chunk: Buffer | string): void => {
      received += chunk.toString();
      const answers = findAnswers(received);
      if (answers.some(({ kind }) => kind === "c")) {
        finish(answers.some(({ kind }) => kind === "u"));
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    input.on("data", onData);
    input.resume();
    output.write(query);
  });
};

/**
 * Turns on modes of the terminal until the returned function turns them off.
 *
 * They are also turned off when the process exits, so that the terminal is not left with keys or
 * pastes that a shell does not read.
 */
const enableModes = (output: NodeJS.WritableStream, on: string, off: string): (() => void) => {
  let enabled = true;
  const disable = (): void => {
    if (enabled) {
      enabled = false;
      process.removeListener("exit", disable);
      output.write(off);
    }
  };
  output.write(on);
  process.once("exit", disable);
  return disable;
};

/** Turns on the disambiguation of keys of the kitty keyboard protocol, so that Shift+Enter differs from Enter. */
export const enableKittyKeyboard = (output: NodeJS.WritableStream): (() => void) =>
  enableModes(output, "\u001B[>1u", "\u001B[<u");

/**
 * Turns on bracketed paste, so that the terminal marks pasted text, whose newlines then do not
 * submit the answer.
 */
export const enableBracketedPaste = (output: NodeJS.WritableStream): (() => void) =>
  enableModes(output, "\u001B[?2004h", "\u001B[?2004l");
