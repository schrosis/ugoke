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

/**
 * Returns whether the text has an answer that ends with a character, such as `u` for the flags
 * of the protocol, which only a terminal with it sends, or `c` for the attributes of the terminal,
 * which almost every terminal sends.
 */
const hasAnswer = (text: string, end: "c" | "u"): boolean => {
  for (
    let start = text.indexOf(answerStart);
    start !== -1;
    start = text.indexOf(answerStart, start + 1)
  ) {
    let index = start + answerStart.length;
    while (index < text.length && "0123456789;".includes(text.charAt(index))) {
      index += 1;
    }
    if (text.charAt(index) === end) {
      return true;
    }
  }
  return false;
};

/** Turns on the disambiguation of keys, so that Shift+Enter differs from Enter. */
const pushFlags = "\u001B[>1u";

/** Restores the flags that the terminal had before {@link pushFlags}. */
const popFlags = "\u001B[<u";

/** Time to wait for the answers of a terminal that answers neither query. */
const defaultTimeoutMs = 200;

/** A stream of keys that can be a terminal. */
type KeyInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * Returns whether the terminal supports the kitty keyboard protocol.
 *
 * It asks for the flags of the protocol and then for the attributes of the terminal, which almost
 * every terminal answers. A terminal that answers the attributes without the flags lacks the
 * protocol. The answers are read as data, not as keys, so that they never reach a prompt.
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
      keys.setRawMode?.(wasRaw);
      input.pause();
      resolve(supported);
    };
    const onData = (chunk: Buffer | string): void => {
      received += chunk.toString();
      if (hasAnswer(received, "c")) {
        finish(hasAnswer(received, "u"));
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    input.on("data", onData);
    input.resume();
    output.write(query);
  });
};

/**
 * Turns on the kitty keyboard protocol until the returned function turns it off.
 *
 * It is also turned off when the process exits, so that the terminal is not left with keys that
 * a shell does not read.
 */
export const enableKittyKeyboard = (output: NodeJS.WritableStream): (() => void) => {
  let enabled = true;
  const disable = (): void => {
    if (enabled) {
      enabled = false;
      process.removeListener("exit", disable);
      output.write(popFlags);
    }
  };
  output.write(pushFlags);
  process.once("exit", disable);
  return disable;
};
