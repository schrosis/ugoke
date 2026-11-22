import { describe, expect, it } from "vitest";

import { parseDefinition } from "./parse.ts";

const validSource = `version: v0.1
start: fetch
steps:
  fetch:
    type: script
    run: ./fetch.sh
    next: end
`;

describe("parseDefinition", () => {
  it("returns a validated definition", () => {
    expect(parseDefinition(validSource)).toMatchObject({
      definition: {
        start: "fetch",
        steps: { fetch: { run: "./fetch.sh", timeout: "30m" } },
        version: "v0.1",
      },
      ok: true,
    });
  });

  it("locates a schema error", () => {
    const source = validSource.replace("next: end", "next: end\n    timeout: 5");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 14, line: 8, path: ["steps", "fetch", "timeout"] }],
      ok: false,
    });
  });

  it("locates a missing field at its parent", () => {
    const source = validSource.replace("    next: end\n", "");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 5, line: 5, path: ["steps", "fetch", "next"] }],
      ok: false,
    });
  });

  it("locates an unknown field", () => {
    const source = validSource.replace("next: end", "next: end\n    retry: 3");

    expect(parseDefinition(source)).toMatchObject({
      errors: [
        {
          column: 5,
          line: 8,
          message: "Unknown field: retry",
          path: ["steps", "fetch", "retry"],
        },
      ],
      ok: false,
    });
  });

  it("locates an invalid step ID", () => {
    const source = validSource.replace("  fetch:", "  my-step:");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 3, line: 4 }],
      ok: false,
    });
  });

  it("locates a non-string step ID", () => {
    const source = validSource.replace(
      "    next: end\n",
      "    next: end\n  1:\n    type: script\n    run: ./x.sh\n    next: end\n",
    );

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 3, line: 8 }],
      ok: false,
    });
  });

  it("returns every schema error", () => {
    const source = validSource
      .replace("version: v0.1", "version: v9")
      .replace("start: fetch", "start: end");

    const result = parseDefinition(source);

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.errors).toHaveLength(2);
  });

  it("rejects a numeric version", () => {
    expect(parseDefinition(validSource.replace("v0.1", "0.1"))).toMatchObject({
      errors: [{ line: 1, path: ["version"] }],
      ok: false,
    });
  });

  it("reports a syntax error", () => {
    expect(parseDefinition("steps: [")).toMatchObject({ ok: false });
  });

  it("rejects duplicate keys", () => {
    const source = validSource.replace("start: fetch", "start: fetch\nstart: fetch");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ line: 3 }],
      ok: false,
    });
  });

  it("rejects multiple documents", () => {
    expect(parseDefinition(`${validSource}---\n${validSource}`)).toMatchObject({ ok: false });
  });

  it("rejects anchors and aliases", () => {
    const source = `version: v0.1
start: first
steps:
  first: &step
    type: script
    run: ./step.sh
    next: end
  second: *step
`;

    const result = parseDefinition(source);

    expect(result.ok ? [] : result.errors.map(({ message }) => message)).toEqual([
      "YAML anchors are not supported",
      "YAML aliases are not supported",
    ]);
  });

  it("does not validate transitions", () => {
    expect(parseDefinition(validSource.replace("next: end", "next: report"))).toMatchObject({
      ok: true,
    });
  });

  it("locates a definition path", () => {
    const result = parseDefinition(validSource);

    expect(result.ok ? result.locate(["steps", "fetch", "next"]) : undefined).toEqual({
      column: 11,
      line: 7,
    });
    expect(result.ok ? result.locate(["steps", "fetch"], { key: true }) : undefined).toEqual({
      column: 3,
      line: 4,
    });
  });

  it("rejects an empty source", () => {
    expect(parseDefinition("")).toMatchObject({
      errors: [{ column: 1, line: 1, path: [] }],
      ok: false,
    });
  });

  it("reads input declarations with their defaults", () => {
    const source = validSource.replace(
      "start: fetch",
      "inputs:\n  threshold:\n    type: number\n    default: -1.5\n  level:\n    type: choice\n    options: [low, high]\n    required: true\nstart: fetch",
    );

    expect(parseDefinition(source)).toMatchObject({
      definition: {
        inputs: {
          level: { options: ["low", "high"], required: true, type: "choice" },
          threshold: { default: -1.5, required: false, type: "number" },
        },
      },
      ok: true,
    });
  });

  it("rejects multiline in a workflow input, which comes as JSON", () => {
    const source = validSource.replace(
      "start: fetch",
      "inputs:\n  notes:\n    type: string\n    multiline: true\nstart: fetch",
    );

    expect(parseDefinition(source)).toMatchObject({
      errors: [
        {
          column: 5,
          line: 5,
          message: "Unknown field: multiline",
          path: ["inputs", "notes", "multiline"],
        },
      ],
      ok: false,
    });
  });

  it("reports a number default of a string input as a type error", () => {
    const source = validSource.replace(
      "start: fetch",
      "inputs:\n  title:\n    type: string\n    default: 1e3\nstart: fetch",
    );

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ message: expect.stringContaining("expected string") as unknown }],
      ok: false,
    });
  });

  it.each(["1e3", "0x10", ".inf", ".nan", "+1"])("rejects the number notation %s", (value) => {
    const source = validSource.replace(
      "start: fetch",
      `inputs:\n  threshold:\n    type: number\n    default: ${value}\nstart: fetch`,
    );

    expect(parseDefinition(source)).toMatchObject({
      errors: [
        {
          column: 14,
          line: 5,
          message: expect.stringContaining("without exponent notation") as unknown,
          path: ["inputs", "threshold", "default"],
        },
      ],
      ok: false,
    });
  });
});

const withWorkflowEnv = (value: string): string =>
  validSource.replace("start: fetch", `env:\n  VALUE: ${value}\nstart: fetch`);

const withStepEnv = (value: string): string =>
  validSource.replace("next: end", `next: end\n    env:\n      VALUE: ${value}`);

describe("parseDefinition env notation", () => {
  it("reads numbers and booleans written as YAML reads them as text", () => {
    const source = validSource
      .replace("start: fetch", "env:\n  PORT: 3000\n  RATE: 0.5\n  DEBUG: true\nstart: fetch")
      .replace("next: end", "next: end\n    env:\n      OFFSET: -1\n      QUIET: false");

    expect(parseDefinition(source)).toMatchObject({
      definition: {
        env: { DEBUG: "true", PORT: "3000", RATE: "0.5" },
        steps: { fetch: { env: { OFFSET: "-1", QUIET: "false" } } },
      },
      ok: true,
    });
  });

  it.each([
    ["1.10", "1.1"],
    ["1.0", "1"],
    ["00123", "123"],
    ["0x1F", "31"],
    ["0o17", "15"],
    ["1e3", "1000"],
    ["+1", "1"],
    ["-0", "0"],
    [".5", "0.5"],
    [".inf", "Infinity"],
    [".nan", "NaN"],
    ["12345678901234567890", "12345678901234567000"],
    ["True", "true"],
    ["TRUE", "true"],
    ["False", "false"],
  ])("rejects %s, which YAML reads as %s", (source, read) => {
    const message = `YAML reads ${source} as ${read}. Quote it to keep it as written, such as "${source}"`;

    expect(parseDefinition(withWorkflowEnv(source))).toEqual({
      errors: [{ column: 10, line: 3, message, path: ["env", "VALUE"] }],
      ok: false,
    });
    expect(parseDefinition(withStepEnv(source))).toEqual({
      errors: [{ column: 14, line: 9, message, path: ["steps", "fetch", "env", "VALUE"] }],
      ok: false,
    });
  });

  it.each([
    ['"1.10"', "1.10"],
    ["'00123'", "00123"],
    ['"True"', "True"],
    ["|-\n    1.10", "1.10"],
    ["${{ workflow.inputs.version }}", "${{ workflow.inputs.version }}"],
  ])("keeps %s as written", (source, value) => {
    expect(parseDefinition(withWorkflowEnv(source))).toMatchObject({
      definition: { env: { VALUE: value } },
      ok: true,
    });
  });

  it("reports the notation once and keeps an error of the name of the same path", () => {
    const source = validSource.replace("start: fetch", "env:\n  1BAD: 1.10\nstart: fetch");

    expect(parseDefinition(source)).toEqual({
      errors: [
        {
          column: 9,
          line: 3,
          message: 'YAML reads 1.10 as 1.1. Quote it to keep it as written, such as "1.10"',
          path: ["env", "1BAD"],
        },
        {
          column: 3,
          line: 3,
          message: "Must start with a letter or _ and contain only letters, digits, or _",
          path: ["env", "1BAD"],
        },
      ],
      ok: false,
    });
  });

  it("reports the notation with the schema errors of other paths", () => {
    const source = withWorkflowEnv("00123").replace("next: end", "next: end\n    retry: 3");

    expect(parseDefinition(source)).toMatchObject({
      errors: [
        { path: ["env", "VALUE"] },
        { message: "Unknown field: retry", path: ["steps", "fetch", "retry"] },
      ],
      ok: false,
    });
  });
});

describe("parseDefinition invalid keys", () => {
  it("explains why a name is invalid", () => {
    const source = validSource.replace("start: fetch", "env:\n  1BAD: x\nstart: fetch");

    expect(parseDefinition(source)).toMatchObject({
      errors: [
        {
          line: 3,
          message: "Must start with a letter or _ and contain only letters, digits, or _",
          path: ["env", "1BAD"],
        },
      ],
      ok: false,
    });
  });
});
