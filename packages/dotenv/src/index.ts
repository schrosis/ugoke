import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { envNamePattern } from "@ugoke/core";

/** A line of a dotenv file that cannot be read. */
export interface DotenvError {
  /** One-based line number. */
  line: number;
  /** Why the line cannot be read. It never contains the name or the value. */
  message: string;
}

/** Result of {@link parseDotenv}. */
export type ParseDotenvResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: DotenvError[] };

// The messages never contain the name or the value, since a value may be a secret and the name
// of a malformed line is unknown.
const messages = {
  assignment: "Expected NAME=value",
  backquote: "Quote a value with single or double quotes, not backquotes",
  backslash:
    'Only \\n and \\$ can follow \\ in double quotes. Use single quotes for a value with \\ or "',
  comment: "A # must follow a space to start a comment. Quote a value that contains #",
  duplicate: (line: number) => `The name is already set on line ${line}`,
  name: "Names must start with a letter or _ and contain only letters, digits, or _",
  reference:
    "Write a variable as $NAME or ${NAME}. Use single quotes, or \\$ in double quotes, for a $ as it is",
  textAfterQuote: "Unexpected text after the closing quote",
  unterminated: (quote: string) => `The value has no closing ${quote}`,
  unset:
    "A variable in the value is set neither on an earlier line nor in the environment. Use single quotes for a $ as it is",
} as const;

/** Whitespace of a dotenv file, which is only spaces and tabs. */
const isBlank = (character: string | undefined): boolean => character === " " || character === "\t";

const trimBlanks = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/gu, "");

const isBlankOrComment = (text: string): boolean => {
  const content = trimBlanks(text);
  return content === "" || content.startsWith("#");
};

/** A part of a value: text as it is, or a variable to expand on the line where it is. */
type ValuePart = { text: string } | { variable: string; line: number };

/** A variable at a `$`: its name and length, `false` for a malformed one, or `undefined` for none. */
type Reference = { name: string; length: number } | false | undefined;

const namePattern = /^[A-Za-z_][A-Za-z0-9_]*/u;

/**
 * Reads a variable that starts with the `$` at `position` of `line`, such as `$HOME` or
 * `${HOME}`. A `$` that a name or `{` does not follow, such as in `$5`, is not a variable.
 */
const readReference = (line: string, position: number): Reference => {
  const after = line.slice(position + 1);
  if (after.startsWith("{")) {
    const close = after.indexOf("}");
    const name = close === -1 ? "" : after.slice(1, close);
    return envNamePattern.test(name) ? { length: close + 2, name } : false;
  }
  const name = namePattern.exec(after)?.[0];
  return name === undefined ? undefined : { length: name.length + 1, name };
};

/** Collects the parts of a value, joining text that follows text. */
const createParts = (): { parts: ValuePart[]; text: (text: string) => void } => {
  const parts: ValuePart[] = [];
  return {
    parts,
    text: (text) => {
      const last = parts.at(-1);
      if (last !== undefined && "text" in last) {
        last.text += text;
      } else if (text !== "") {
        parts.push({ text });
      }
    },
  };
};

/**
 * Splits text that has no escapes into its parts, such as an unquoted value.
 *
 * @returns `undefined` when a variable is malformed.
 */
const splitReferences = (text: string, line: number): ValuePart[] | undefined => {
  const { parts, text: addText } = createParts();
  let position = 0;
  while (position < text.length) {
    const dollar = text.indexOf("$", position);
    if (dollar === -1) {
      addText(text.slice(position));
      break;
    }
    addText(text.slice(position, dollar));
    const reference = readReference(text, dollar);
    if (reference === false) {
      return undefined;
    }
    if (reference === undefined) {
      addText("$");
      position = dollar + 1;
    } else {
      parts.push({ line, variable: reference.name });
      position = dollar + reference.length;
    }
  }
  return parts;
};

/** A quoted value and where its closing quote is. */
interface QuotedValue {
  parts: ValuePart[];
  /** Zero-based index of the line of the closing quote. */
  end: number;
  /** Text after the closing quote on its line. */
  rest: string;
  /** One-based line number of the first backslash that is not allowed, if any. */
  badEscape?: number;
  /** One-based line number of the first malformed variable, if any. */
  badReference?: number;
}

/**
 * Reads a value in quotes that opens at `column` of `lines[start]`, which may span lines.
 * Variables are read in double quotes, and not in single quotes.
 *
 * A backslash or a variable that is not allowed is returned instead of reported, so that nothing
 * is reported from the lines after a quote that is never closed.
 *
 * @returns `undefined` when the quote is never closed.
 */
const readQuoted = (
  lines: readonly string[],
  start: number,
  column: number,
): QuotedValue | undefined => {
  const quote = lines[start]?.[column];
  let row = start;
  let position = column + 1;
  const { parts, text: addText } = createParts();
  let badEscape: number | undefined;
  let badReference: number | undefined;
  for (;;) {
    const line = lines[row];
    if (line === undefined) {
      return undefined;
    }
    const character = line[position];
    if (character === undefined) {
      // The line break is a part of the value.
      addText("\n");
      row += 1;
      position = 0;
    } else if (character === quote) {
      return {
        end: row,
        parts,
        rest: line.slice(position + 1),
        ...(badEscape === undefined ? {} : { badEscape }),
        ...(badReference === undefined ? {} : { badReference }),
      };
    } else if (quote === '"' && character === "$") {
      const reference = readReference(line, position);
      if (reference === undefined) {
        addText("$");
        position += 1;
      } else if (reference === false) {
        badReference ??= row + 1;
        position += 1;
      } else {
        parts.push({ line: row + 1, variable: reference.name });
        position += reference.length;
      }
    } else if (quote === '"' && character === "\\") {
      const escaped = line[position + 1];
      if (escaped === "n") {
        addText("\n");
      } else if (escaped === "$") {
        addText("$");
      } else {
        badEscape ??= row + 1;
      }
      // The escaped character is skipped even when it is not allowed, so that `"a\"b"` does not
      // end at the escaped quote and shift the lines after it.
      if (position + 1 < line.length) {
        position += 2;
      } else {
        row += 1;
        position = 0;
      }
    } else {
      addText(character);
      position += 1;
    }
  }
};

/** Reads a value without quotes that starts at `column` of `line`, and drops a comment. */
const readUnquoted = (
  line: string,
  number: number,
  column: number,
  errors: DotenvError[],
): ValuePart[] => {
  const hash = line.indexOf("#", column);
  if (hash !== -1 && !isBlank(line[hash - 1])) {
    errors.push({ line: number, message: messages.comment });
  }
  const text = trimBlanks(hash === -1 ? line.slice(column) : line.slice(column, hash));
  const parts = splitReferences(text, number);
  if (parts === undefined) {
    errors.push({ line: number, message: messages.reference });
    return [];
  }
  return parts;
};

/**
 * Expands the variables of a value with the values of the earlier lines, and then with the
 * inherited environment. A value that a variable gives is not expanded again.
 *
 * @returns The value, or the line of the first variable that is not set.
 */
const expand = (
  parts: readonly ValuePart[],
  earlier: ReadonlyMap<string, string>,
  inherited: Readonly<Record<string, string | undefined>>,
): { value: string } | { unsetOn: number } => {
  let value = "";
  for (const part of parts) {
    if ("text" in part) {
      value += part.text;
      continue;
    }
    const found =
      earlier.get(part.variable) ??
      (Object.hasOwn(inherited, part.variable) ? inherited[part.variable] : undefined);
    if (found === undefined) {
      return { unsetOn: part.line };
    }
    value += found;
  }
  return { value };
};

/**
 * Parses the text of a dotenv file in the format that ugoke supports.
 *
 * A byte order mark at the start is skipped, and lines may end with LF or CRLF. Each line is
 * blank, a comment that starts with `#`, or an assignment `NAME=value`, optionally prefixed with
 * `export`. Names must match the names of `env` in definitions. A value is either:
 *
 * - Unquoted, with the surrounding whitespace removed. A `#` after whitespace starts a comment.
 * - In single quotes, taken as written.
 * - In double quotes, where `\n` is a line break, `\$` is a `$`, and no other backslash is
 *   allowed.
 *
 * Quoted values may span lines, and only whitespace and a comment may follow them. Variables such
 * as `$HOME` and `${HOME}` are expanded in unquoted values and in double quotes, with the values of
 * the earlier lines first, and then with the inherited environment. A `$` that neither a name nor
 * `{` follows is a `$`. A variable that neither gives fails the line.
 *
 * Every malformed line is reported, and no values are returned when there is any. The text after a
 * quote that is never closed is not read, since where its lines start is unknown.
 */
export const parseDotenv = (
  text: string,
  inherited: Readonly<Record<string, string | undefined>> = {},
): ParseDotenvResult => {
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text)
    .replaceAll("\r\n", "\n")
    .split("\n");
  const errors: DotenvError[] = [];
  // A map keeps a name such as `__proto__` from changing the prototype of the values.
  const values = new Map<string, string>();
  const assignedOn = new Map<string, number>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const number = index + 1;
    index += 1;
    if (isBlankOrComment(line)) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      errors.push({ line: number, message: messages.assignment });
      continue;
    }
    const name = trimBlanks(line.slice(0, equals)).replace(/^export[ \t]+/u, "");
    const valid = envNamePattern.test(name);
    const assigned = assignedOn.get(name);
    if (!valid) {
      errors.push({ line: number, message: messages.name });
    } else if (assigned === undefined) {
      assignedOn.set(name, number);
    } else {
      errors.push({ line: number, message: messages.duplicate(assigned) });
    }

    let column = equals + 1;
    while (isBlank(line[column])) {
      column += 1;
    }
    const quote = line[column];
    if (quote === "`") {
      errors.push({ line: number, message: messages.backquote });
      continue;
    }
    let parts: ValuePart[];
    if (quote === "'" || quote === '"') {
      const quoted = readQuoted(lines, index - 1, column);
      if (quoted === undefined) {
        errors.push({ line: number, message: messages.unterminated(quote) });
        break;
      }
      if (quoted.badEscape !== undefined) {
        errors.push({ line: quoted.badEscape, message: messages.backslash });
      }
      if (quoted.badReference !== undefined) {
        errors.push({ line: quoted.badReference, message: messages.reference });
      }
      if (!isBlankOrComment(quoted.rest)) {
        errors.push({ line: quoted.end + 1, message: messages.textAfterQuote });
      }
      index = quoted.end + 1;
      ({ parts } = quoted);
    } else {
      parts = readUnquoted(line, number, column, errors);
    }
    const expanded = expand(parts, values, inherited);
    if ("unsetOn" in expanded) {
      errors.push({ line: expanded.unsetOn, message: messages.unset });
    } else if (valid && assigned === undefined) {
      values.set(name, expanded.value);
    }
  }
  return errors.length === 0
    ? { ok: true, values: Object.fromEntries(values) }
    : { errors, ok: false };
};

/**
 * Number of malformed lines that {@link readDotenv} reports. The message becomes a part of the
 * failure of a step, which the workflow history keeps, so a large file that is not a dotenv file
 * does not fill it.
 */
const reportedErrors = 10;

/** Result of {@link readDotenv}. */
export type DotenvResult =
  | { ok: true; values: NodeJS.Dict<string> }
  | { ok: false; message: string };

/**
 * Reads a dotenv file, relative to the working directory.
 *
 * The file is read in the format of {@link parseDotenv}, and is not read at all when any line is
 * malformed. The first malformed lines are reported, and the rest are only counted. It is read
 * each time a step runs, so its values never enter the workflow history. A file that a symbolic
 * link puts outside of the working directory is not read.
 *
 * @param inherited The environment that variables in values are expanded with after the earlier
 *   lines, which is that of this process by default.
 */
export const readDotenv = (
  cwd: string,
  path: string,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): DotenvResult => {
  const failure = (reason: string): DotenvResult => ({
    message: `Failed to read the dotenv file ${path}: ${reason}`,
    ok: false,
  });
  let file: string;
  try {
    const root = realpathSync(cwd);
    file = realpathSync(resolve(cwd, path));
    const inside = relative(root, file);
    // Segments are compared, so that a file such as ..env in the root is inside.
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return failure("it is outside of the project root");
    }
    const parsed = parseDotenv(readFileSync(file, "utf8"), inherited);
    if (!parsed.ok) {
      const reasons = parsed.errors
        .slice(0, reportedErrors)
        .map(({ line, message }) => `line ${line}: ${message}`);
      const more = parsed.errors.length - reasons.length;
      return failure([...reasons, ...(more > 0 ? [`and ${more} more`] : [])].join("; "));
    }
    return { ok: true, values: parsed.values };
  } catch (error) {
    // The reason is kept in the message, so that it is reported with the step.
    return failure(error instanceof Error ? error.message : String(error));
  }
};

/**
 * Returns the environment that a step sees besides the variables of its definition, which take
 * precedence over it.
 *
 * Inherited variables take precedence over the dotenv file. Scripts, AI steps, and conditions all
 * use it, so that they see the same values.
 */
export const readEnvironment = (cwd: string, dotenv: string | undefined): DotenvResult => {
  if (dotenv === undefined) {
    return { ok: true, values: { ...process.env } };
  }
  const file = readDotenv(cwd, dotenv);
  return file.ok ? { ok: true, values: { ...file.values, ...process.env } } : file;
};
