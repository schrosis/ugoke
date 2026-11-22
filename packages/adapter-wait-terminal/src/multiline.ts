import {
  createPrompt,
  isBackspaceKey,
  isEnterKey,
  makeTheme,
  useKeypress,
  usePrefix,
  useState,
} from "@inquirer/core";
import type { KeypressEvent } from "@inquirer/core";

import { kittyKeys } from "./keyboard.js";

/** Options of {@link multilinePrompt}. */
export interface MultilineConfig {
  message: string;
  /** Answer of an empty input. */
  default?: string | undefined;
  /** Whether Shift+Enter starts a new line, which needs the kitty keyboard protocol. */
  shiftEnter: boolean;
  /** Returns `true` for a valid answer, or a message that tells what is wrong. */
  validate: (value: string) => string | true;
  /**
   * Interrupts the command, as Ctrl+C does elsewhere. The kitty keyboard protocol sends Ctrl+C as
   * a sequence, which reaches the prompt as a key.
   */
  interrupt: () => void;
}

/** A key as readline reads it, which also tells Alt and the sequence that the terminal sent. */
type RawKey = KeypressEvent & { meta?: boolean; sequence?: string };

/** Indent of the lines of the answer, under the message. */
const indent = "  ";

/** Returns whether a key starts a new line instead of submitting the answer. */
const startsNewLine = (key: RawKey): boolean =>
  key.sequence === kittyKeys.shiftEnter ||
  key.sequence === kittyKeys.altEnter ||
  (isEnterKey(key) && key.meta === true);

/** Returns how to start a new line in the terminal, which the prompt shows under the input. */
const hintOf = (shiftEnter: boolean): string =>
  `Enter to submit. New line: ${shiftEnter ? "Shift+Enter, " : ""}Alt+Enter, or \\ then Enter`;

/** The type of a prompt that answers with text, as `createPrompt` creates it. */
type MultilinePrompt = ReturnType<typeof createPrompt<string, MultilineConfig>>;

/**
 * Asks for text that can span lines, in the terminal itself.
 *
 * Enter submits the answer. Alt+Enter and a `\` at the end of the line start a new line, and so
 * does Shift+Enter when the terminal sends it apart from Enter. Pasted text keeps its newlines
 * while bracketed paste is on.
 */
export const multilinePrompt: MultilinePrompt = createPrompt<string, MultilineConfig>(
  (config, done) => {
    const theme = makeTheme();
    const [status, setStatus] = useState<"done" | "idle">("idle");
    // The answer after it is submitted, which can be the default.
    const [answered, setAnswered] = useState("");
    // The lines before the one that the cursor is on.
    const [lines, setLines] = useState<readonly string[]>([]);
    // The line that the cursor is on. readline clears its own line on Enter, so it is kept here.
    const [value, setValue] = useState("");
    const [pasting, setPasting] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const prefix = usePrefix({ status, theme });

    useKeypress((event, rl) => {
      const key: RawKey = event;
      if (status !== "idle") {
        return;
      }
      if (key.sequence === kittyKeys.ctrlC) {
        config.interrupt();
        return;
      }
      if (key.name === "paste-start" || key.name === "paste-end") {
        setPasting(key.name === "paste-start");
        setValue(rl.line);
        return;
      }
      const breakLine = (line: string): void => {
        setLines([...lines, line]);
        setValue("");
        setError(undefined);
        rl.clearLine(0);
      };
      if (startsNewLine(key) || (pasting && isEnterKey(key))) {
        breakLine(value);
        return;
      }
      if (isEnterKey(key)) {
        if (value.endsWith("\\")) {
          breakLine(value.slice(0, -1));
          return;
        }
        const text = [...lines, value].join("\n");
        const answer = text === "" && config.default !== undefined ? config.default : text;
        const valid = config.validate(answer);
        if (valid === true) {
          setAnswered(answer);
          setStatus("done");
          done(answer);
          return;
        }
        // readline cleared the line, which is written again to fix it.
        rl.write(value);
        setError(valid);
        return;
      }
      if (isBackspaceKey(key) && value === "" && rl.line === "" && lines.length > 0) {
        // Backspace at the start of a line joins it with the line before.
        const previous = lines.at(-1) ?? "";
        setLines(lines.slice(0, -1));
        rl.write(previous);
        setValue(previous);
        return;
      }
      setValue(rl.line);
      setError(undefined);
    });

    const message = theme.style.message(config.message, status);
    if (status === "done") {
      return `${prefix} ${message}\n${theme.style.answer(
        answered
          .split("\n")
          .map((line) => `${indent}${line}`)
          .join("\n"),
      )}`;
    }
    const empty = lines.length === 0 && value === "";
    const defaultText =
      empty && config.default !== undefined ? ` ${theme.style.defaultAnswer(config.default)}` : "";
    // The line of the cursor comes last, so that readline places the cursor at its end.
    const content = [
      `${prefix} ${message}${defaultText}`,
      ...lines.map((line) => `${indent}${line}`),
      `${indent}${value}`,
    ].join("\n");
    const bottom = [
      theme.style.help(hintOf(config.shiftEnter)),
      ...(error === undefined ? [] : [theme.style.error(error)]),
    ].join("\n");
    return [content, bottom];
  },
);
