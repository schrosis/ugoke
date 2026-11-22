import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseDotenv, readDotenv, readEnvironment } from "./index.ts";

describe("parseDotenv", () => {
  it.each([
    ["a blank line", "\n", {}],
    ["a line of whitespace", " \t \n", {}],
    ["a comment", "# note\n", {}],
    ["a comment after whitespace", "  \t# note\n", {}],
    ["an assignment", "A=value\n", { A: "value" }],
    ["whitespace around the name and after =", " \tA \t= \tvalue\n", { A: "value" }],
    ["export", "export A=value\n", { A: "value" }],
    ["export with whitespace", "export \t A=value\n", { A: "value" }],
    ["a name that is export", "export=value\n", { export: "value" }],
    ["a name that starts with _", "_A1=value\n", { _A1: "value" }],
    ["an unquoted value", "A=hello world\n", { A: "hello world" }],
    ["trailing whitespace", "A=value \t\n", { A: "value" }],
    ["a comment after an unquoted value", "A=1 # count\n", { A: "1" }],
    ["a comment after a tab", "A=1\t# count\n", { A: "1" }],
    ["a comment as the value", "A= # count\n", { A: "" }],
    ["an empty value", "A=\n", { A: "" }],
    ["an = in the value", "A=a=b\n", { A: "a=b" }],
    ["quotes inside an unquoted value", "A=a \"b\" 'c'\n", { A: "a \"b\" 'c'" }],
    ["single quotes", "J='{\"a\":1}'\n", { J: '{"a":1}' }],
    ["single quotes with \\ and #", "A='a\\nb#c'\n", { A: "a\\nb#c" }],
    ["empty single quotes", "A=''\n", { A: "" }],
    ["double quotes", 'A="a\\nb"\n', { A: "a\nb" }],
    ["double quotes with ' and #", 'A="it\'s #1"\n', { A: "it's #1" }],
    ["whitespace in quotes", 'A=" a "\n', { A: " a " }],
    ["a comment after a closing quote", "A='x' # note\n", { A: "x" }],
    ["a comment right after a closing quote", 'A="x"# note\n', { A: "x" }],
    ["whitespace after a closing quote", 'A="x" \t\n', { A: "x" }],
    ["single quotes over lines", "A='a\nb'\nB=c\n", { A: "a\nb", B: "c" }],
    ["double quotes over lines", 'A="a\n\nb"\nB=c\n', { A: "a\n\nb", B: "c" }],
    ["a variable in single quotes", "A='$HOME ${HOME}'\n", { A: "$HOME ${HOME}" }],
    ["no line break at the end", "A=1", { A: "1" }],
  ])("reads %s", (_, text, values) => {
    expect(parseDotenv(text)).toEqual({ ok: true, values });
  });

  it.each([
    "",
    "A=1\nB=2\n",
    "# comment\n\n  \nA=1\n",
    " \tA \t= \tvalue \t\n",
    "export A=1\nexport=2\n",
    "A=hello world\n",
    "A=1 # count\nB=2\t# count\nC= # count\n",
    "A=\nB=  \n",
    "A=a=b\nB=a\"b\nC=a'b\nD=a`b\n",
    "J='{\"a\":1}'\nK='a\\nb#c'\nL=''\n",
    'A="a\\nb\\nc"\nB="\\n"\nC=""\nD=" a "\nE="it\'s #1"\n',
    'A=\'x\' # note\nB="x"# note\nC="x" \t\n',
    "A='a\nb'\nB=\"c\n\nd\"\nE=f\n",
    "A=café 日本語\n",
    "__proto__=x\n",
  ])("reads %j as util.parseEnv does", (text) => {
    expect(parseDotenv(text)).toEqual({ ok: true, values: { ...parseEnv(text) } });
  });

  it("skips a byte order mark, which util.parseEnv keeps in the first name", () => {
    expect(parseDotenv("\uFEFFA=1\n")).toEqual({ ok: true, values: { A: "1" } });
    expect(Object.keys(parseEnv("\uFEFFA=1\n"))).toEqual(["\uFEFFA"]);
  });

  it("reads CRLF line breaks, including those in a value", () => {
    expect(parseDotenv("A=a\r\n# note\r\nB='b\r\nc'\r\nC=\"d\r\ne\"\r\n")).toEqual({
      ok: true,
      values: { A: "a", B: "b\nc", C: "d\ne" },
    });
  });

  it("keeps a carriage return that is not followed by a line feed", () => {
    expect(parseDotenv("A='a\rb'\n")).toEqual({ ok: true, values: { A: "a\rb" } });
  });

  it("reads __proto__ as a name without changing the prototype", () => {
    const result = parseDotenv("__proto__=x\n");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.values)).toBe(Object.prototype);
      expect(Object.hasOwn(result.values, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(result.values, "__proto__")?.value).toBe("x");
    }
  });

  it.each([
    ["no =", "TOKEN\n", [{ line: 1, message: "Expected NAME=value" }]],
    ["export without =", "export TOKEN\n", [{ line: 1, message: "Expected NAME=value" }]],
    [
      "a malformed name",
      "B=1\nA-B=1\n",
      [
        {
          line: 2,
          message: "Names must start with a letter or _ and contain only letters, digits, or _",
        },
      ],
    ],
    [
      "an empty name",
      "=1\n",
      [
        {
          line: 1,
          message: "Names must start with a letter or _ and contain only letters, digits, or _",
        },
      ],
    ],
    [
      "a second assignment of a name",
      "A=1\nB=2\nA=3\n",
      [{ line: 3, message: "The name is already set on line 1" }],
    ],
    [
      "a backslash other than \\n in double quotes",
      'B=1\nC=2\nD=3\nA="a\\"b"\n',
      [
        {
          line: 4,
          message:
            'Only \\n and \\$ can follow \\ in double quotes. Use single quotes for a value with \\ or "',
        },
      ],
    ],
    [
      "an unterminated double quote",
      'B=1\nC=2\nD=3\nE=4\nA="unterminated\n',
      [{ line: 5, message: 'The value has no closing "' }],
    ],
    [
      "an unterminated single quote",
      "A='unterminated\n",
      [{ line: 1, message: "The value has no closing '" }],
    ],
    [
      "text after a closing quote",
      'B=1\nC=2\nD=3\nE=4\nF=5\nA="x"y\n',
      [{ line: 6, message: "Unexpected text after the closing quote" }],
    ],
    [
      "a ' in single quotes",
      "A='it's'\n",
      [{ line: 1, message: "Unexpected text after the closing quote" }],
    ],
    [
      "a # that does not follow whitespace",
      "B=1\nC=2\nD=3\nE=4\nF=5\nG=6\nURL=https://example.com/#top\n",
      [
        {
          line: 7,
          message: "A # must follow a space to start a comment. Quote a value that contains #",
        },
      ],
    ],
    [
      "a # at the start of a value",
      "A=#top\n",
      [
        {
          line: 1,
          message: "A # must follow a space to start a comment. Quote a value that contains #",
        },
      ],
    ],
    [
      "backquotes",
      "B=1\nC=2\nD=3\nE=4\nF=5\nG=6\nH=7\nA=`x`\n",
      [{ line: 8, message: "Quote a value with single or double quotes, not backquotes" }],
    ],
  ])("reports %s", (_, text, errors) => {
    expect(parseDotenv(text)).toEqual({ errors, ok: false });
  });

  it("reports the line of an error in a value over lines", () => {
    expect(parseDotenv('A="a\nb\\"c\nd"x\n')).toEqual({
      errors: [
        {
          line: 2,
          message:
            'Only \\n and \\$ can follow \\ in double quotes. Use single quotes for a value with \\ or "',
        },
        { line: 3, message: "Unexpected text after the closing quote" },
      ],
      ok: false,
    });
  });

  it("reports a backslash at the end of a line once and reads the value to its closing quote", () => {
    expect(parseDotenv('A="a\\\nb\\"c"\nB=1\n')).toEqual({
      errors: [
        {
          line: 1,
          message:
            'Only \\n and \\$ can follow \\ in double quotes. Use single quotes for a value with \\ or "',
        },
      ],
      ok: false,
    });
  });

  it("reports every malformed line without values", () => {
    expect(parseDotenv("TOKEN\nA=1\nA-B=1\nA=2\nB=`x`\nC=ok\n")).toEqual({
      errors: [
        { line: 1, message: "Expected NAME=value" },
        {
          line: 3,
          message: "Names must start with a letter or _ and contain only letters, digits, or _",
        },
        { line: 4, message: "The name is already set on line 2" },
        { line: 5, message: "Quote a value with single or double quotes, not backquotes" },
      ],
      ok: false,
    });
  });

  it("does not read the text after a quote that is never closed", () => {
    expect(parseDotenv("TOKEN\nA='open\nB=1\nMALFORMED\nA=2\n")).toEqual({
      errors: [
        { line: 1, message: "Expected NAME=value" },
        { line: 2, message: "The value has no closing '" },
      ],
      ok: false,
    });
  });

  it("does not report a backslash after a quote that is never closed", () => {
    expect(parseDotenv('A="open\\"\nB=x\\y\n')).toEqual({
      errors: [{ line: 1, message: 'The value has no closing "' }],
      ok: false,
    });
  });

  it.each([
    "SECRET_TOKEN s3cr3t\n",
    "SECRET-TOKEN=s3cr3t\n",
    "SECRET_TOKEN=s3cr3t\nSECRET_TOKEN=s3cr3t\n",
    'SECRET_TOKEN="s3cr3t\\"s3cr3t"\n',
    'SECRET_TOKEN="s3cr3t\n',
    "SECRET_TOKEN='s3cr3t's3cr3t\n",
    "SECRET_TOKEN=s3cr3t#s3cr3t\n",
    "SECRET_TOKEN=`s3cr3t`\n",
  ])("does not report the name or the value of %j", (text) => {
    const result = parseDotenv(text);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|s3cr3t/u);
  });
});

describe("parseDotenv variables", () => {
  const inherited = { HOME: "/home/me", EMPTY: "", USER: "me" };

  it.each([
    ["$NAME unquoted", "A=$HOME/bin\n", { A: "/home/me/bin" }],
    ["${NAME} unquoted", "A=${HOME}bin\n", { A: "/home/mebin" }],
    ["$NAME in double quotes", 'A="$HOME and ${USER}"\n', { A: "/home/me and me" }],
    ["an earlier line", "B=/srv\nA=${B}/app\n", { A: "/srv/app", B: "/srv" }],
    [
      "the environment over an earlier line",
      "HOME=/srv\nA=$HOME\n",
      { A: "/home/me", HOME: "/srv" },
    ],
    ["the environment for the name itself", "HOME=$HOME/x\n", { HOME: "/home/me/x" }],
    ["an empty variable", "A=[$EMPTY]\n", { A: "[]" }],
    ["a $ that a name does not follow", "A=$5 and a$\n", { A: "$5 and a$" }],
    ["\\$ in double quotes", 'A="\\$HOME"\n', { A: "$HOME" }],
    ["a value that a variable gives as it is", "B='$USER'\nA=$B\n", { A: "$USER", B: "$USER" }],
    ["a variable on a later line of a value", 'A="first\n$USER"\n', { A: "first\nme" }],
  ])("expands %s", (_, text, values) => {
    expect(parseDotenv(text, inherited)).toEqual({ ok: true, values });
  });

  const unset =
    "A variable in the value is set neither on an earlier line nor in the environment. Use single quotes for a $ as it is";
  const reference =
    "Write a variable as $NAME or ${NAME}. Use single quotes, or \\$ in double quotes, for a $ as it is";

  it.each([
    ["a variable that is set nowhere", "A=1\nB=$NOPE\n", [{ line: 2, message: unset }]],
    ["a later line", "A=$B\nB=1\n", [{ line: 1, message: unset }]],
    [
      "a variable in double quotes on a later line",
      'A="x\n${NOPE}"\n',
      [{ line: 2, message: unset }],
    ],
    ["an unclosed brace", "A=${HOME\n", [{ line: 1, message: reference }]],
    ["a brace without a name", "A=${}\n", [{ line: 1, message: reference }]],
    ["a brace with a bad name", 'A="${1A}"\n', [{ line: 1, message: reference }]],
  ])("reports %s", (_, text, errors) => {
    expect(parseDotenv(text, inherited)).toEqual({ errors, ok: false });
  });

  it("expands with a variable that the environment overrides, as the step sees it", () => {
    expect(parseDotenv("BASE=/srv/app\nLOG_DIR=${BASE}/logs\n", { BASE: "/ci" })).toEqual({
      ok: true,
      values: { BASE: "/srv/app", LOG_DIR: "/ci/logs" },
    });
  });

  it("does not read a name that objects inherit from the environment", () => {
    expect(parseDotenv("A=$constructor\n", {})).toEqual({
      errors: [{ line: 1, message: unset }],
      ok: false,
    });
  });

  it("names neither the variable nor the value in a message", () => {
    const result = parseDotenv("A=$SECRET_NAME\n", {});

    expect(JSON.stringify(result)).not.toMatch(/SECRET_NAME/u);
  });
});

describe("readDotenv", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-dotenv-")));
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  it("reads a file in the working directory", () => {
    writeFileSync(join(cwd, ".env"), "NAME=value\n");

    expect(readDotenv(cwd, ".env")).toEqual({ ok: true, values: { NAME: "value" } });
  });

  it("expands variables with the environment that it is given", () => {
    writeFileSync(join(cwd, ".env"), "A=$GREETING/x\n");

    expect(readDotenv(cwd, ".env", { GREETING: "hi" })).toEqual({
      ok: true,
      values: { A: "hi/x" },
    });
  });

  it("reports every malformed line of the file", () => {
    writeFileSync(join(cwd, ".env"), 'A=1\nB=2\nA=3\nC=4\nD="unterminated\n');

    expect(readDotenv(cwd, ".env")).toEqual({
      message:
        'Failed to read the dotenv file .env: line 3: The name is already set on line 1; line 5: The value has no closing "',
      ok: false,
    });
  });

  it("reports the first ten malformed lines and counts the rest", () => {
    writeFileSync(join(cwd, ".env"), "TOKEN\n".repeat(12));
    const reasons = Array.from(
      { length: 10 },
      (_, index) => `line ${index + 1}: Expected NAME=value`,
    );

    expect(readDotenv(cwd, ".env")).toEqual({
      message: `Failed to read the dotenv file .env: ${reasons.join("; ")}; and 2 more`,
      ok: false,
    });
  });

  it("reports ten malformed lines without a count", () => {
    writeFileSync(join(cwd, ".env"), "TOKEN\n".repeat(10));

    expect(readDotenv(cwd, ".env")).toMatchObject({
      message: expect.stringMatching(/line 10: Expected NAME=value$/u) as unknown,
      ok: false,
    });
  });

  it("reads a file in the root whose name starts with two dots", () => {
    writeFileSync(join(cwd, "..env"), "NAME=value\n");

    expect(readDotenv(cwd, "..env")).toMatchObject({ ok: true });
  });

  it("reports a missing file", () => {
    expect(readDotenv(cwd, "missing.env")).toMatchObject({
      message: expect.stringContaining(
        "Failed to read the dotenv file missing.env: ENOENT",
      ) as unknown,
      ok: false,
    });
  });

  it("does not read a file outside of the working directory through a link", () => {
    const outside = mkdtempSync(join(tmpdir(), "ugoke-outside-"));
    try {
      writeFileSync(join(outside, "secrets.env"), "SECRET=x\n");
      symlinkSync(join(outside, "secrets.env"), join(cwd, ".env"));

      expect(readDotenv(cwd, ".env")).toEqual({
        message: "Failed to read the dotenv file .env: it is outside of the project root",
        ok: false,
      });
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

describe("readEnvironment", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-environment-")));
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  it("returns the inherited variables without a file", () => {
    expect(readEnvironment(cwd, undefined)).toEqual({ ok: true, values: process.env });
  });

  it("keeps inherited variables over the file", () => {
    writeFileSync(join(cwd, ".env"), "FROM_FILE=file\nHOME=from-file\n");

    expect(readEnvironment(cwd, ".env")).toMatchObject({
      ok: true,
      values: { FROM_FILE: "file", HOME: process.env.HOME },
    });
  });

  it("reports a file that cannot be read", () => {
    expect(readEnvironment(cwd, "missing.env")).toMatchObject({ ok: false });
  });
});
