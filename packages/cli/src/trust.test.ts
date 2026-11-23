import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "./testing.ts";
import { createTrustStore, ensureTrustedProject, trustCreatedProject } from "./trust.ts";
import type { TrustAnswer, TrustStore } from "./trust.ts";

let directory: string;
let file: string;
let root: string;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-trust-")));
  file = join(directory, "trusted-projects.json");
  root = join(directory, "project");
  mkdirSync(join(root, ".ugoke"), { recursive: true });
});

afterEach(() => {
  chmodSync(directory, 0o700);
  rmSync(directory, { force: true, recursive: true });
});

/** A terminal where the user gives an answer, which counts the questions. */
const createAsker = (answer: TrustAnswer) => {
  const asked: string[] = [];
  return {
    askTrust: async (asking: string) => {
      asked.push(asking);
      return Promise.resolve(answer);
    },
    asked,
  };
};

describe("createTrustStore", () => {
  it("has no root before one is added", () => {
    expect(createTrustStore(() => file).has(root)).toBe(false);
  });

  it("keeps the roots that are added in a file that only the user can read", () => {
    const store = createTrustStore(() => file);

    store.add(root);
    store.add("/other");
    store.add(root);

    expect(createTrustStore(() => file).has(root)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([root, "/other"]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("has no root when the record cannot be read", () => {
    writeFileSync(file, "{");

    expect(createTrustStore(() => file).has(root)).toBe(false);
  });

  it("replaces a record that cannot be read when a root is added", () => {
    writeFileSync(file, "{");
    const store = createTrustStore(() => file);

    store.add(root);

    expect(store.has(root)).toBe(true);
  });

  it("throws when the record cannot be written", () => {
    chmodSync(directory, 0o500);

    expect(() => createTrustStore(() => file).add(root)).toThrow(/EACCES/u);
  });
});

describe("ensureTrustedProject", () => {
  let store: TrustStore;

  beforeEach(() => {
    store = createTrustStore(() => file);
  });

  it("asks about a root that is not trusted, and records a yes", async () => {
    const output = createOutput();
    const asker = createAsker("yes");

    await expect(
      ensureTrustedProject({ cwd: root, trustStore: store, ...asker, ...output }),
    ).resolves.toBeUndefined();

    expect(asker.asked).toEqual([root]);
    expect(store.has(root)).toBe(true);
    expect(output.written).toEqual({ stderr: "", stdout: "" });
  });

  it("does not ask about a trusted root", async () => {
    store.add(root);
    const asker = createAsker("no");

    await expect(
      ensureTrustedProject({ cwd: root, trustStore: store, ...asker, ...createOutput() }),
    ).resolves.toBeUndefined();

    expect(asker.asked).toEqual([]);
  });

  it("asks about the nearest root from a directory inside it", async () => {
    const inside = join(root, "packages", "a");
    mkdirSync(inside, { recursive: true });
    const asker = createAsker("yes");

    await ensureTrustedProject({ cwd: inside, trustStore: store, ...asker, ...createOutput() });

    expect(asker.asked).toEqual([root]);
  });

  it("asks about a root inside a trusted root", async () => {
    store.add(root);
    const inner = join(root, "vendor", "other");
    mkdirSync(join(inner, ".ugoke"), { recursive: true });
    const asker = createAsker("no");

    await expect(
      ensureTrustedProject({ cwd: inner, trustStore: store, ...asker, ...createOutput() }),
    ).resolves.toBe(1);

    expect(asker.asked).toEqual([inner]);
  });

  it("trusts the real path of a root that is reached through a symbolic link", async () => {
    const link = join(directory, "link");
    symlinkSync(root, link);
    const asker = createAsker("yes");

    await ensureTrustedProject({ cwd: link, trustStore: store, ...asker, ...createOutput() });

    expect(asker.asked).toEqual([root]);
    expect(store.has(root)).toBe(true);
  });

  it("ends with 1 and records nothing on a no", async () => {
    const output = createOutput();

    await expect(
      ensureTrustedProject({ cwd: root, trustStore: store, ...createAsker("no"), ...output }),
    ).resolves.toBe(1);

    expect(store.has(root)).toBe(false);
    expect(output.written).toEqual({
      stderr: `ugoke: ${root} is not trusted, so nothing in it was read\n`,
      stdout: "",
    });
  });

  it("ends with 130 and records nothing when interrupted", async () => {
    const output = createOutput();

    await expect(
      ensureTrustedProject({
        cwd: root,
        trustStore: store,
        ...createAsker("interrupted"),
        ...output,
      }),
    ).resolves.toBe(130);

    expect(store.has(root)).toBe(false);
    expect(output.written).toEqual({ stderr: "", stdout: "" });
  });

  it("ends with 1 when a yes cannot be recorded", async () => {
    chmodSync(directory, 0o500);
    const output = createOutput();

    await expect(
      ensureTrustedProject({ cwd: root, trustStore: store, ...createAsker("yes"), ...output }),
    ).resolves.toBe(1);

    expect(output.written.stderr).toMatch(
      /^ugoke: could not record that .+ is trusted, so nothing in it was read: EACCES/u,
    );
  });

  it("goes on without reading or writing the record when nobody can answer", async () => {
    await expect(
      ensureTrustedProject({ cwd: root, trustStore: store, ...createOutput() }),
    ).resolves.toBeUndefined();

    expect(store.has(root)).toBe(false);
  });

  it("goes on without asking when a program runs the command", async () => {
    const asker = createAsker("no");

    await expect(
      ensureTrustedProject({ cwd: root, trustStore: store, ...asker, ...createOutput() }, true),
    ).resolves.toBeUndefined();

    expect(asker.asked).toEqual([]);
    expect(store.has(root)).toBe(false);
  });

  it("leaves a directory without a project to the command", async () => {
    const asker = createAsker("no");

    await expect(
      ensureTrustedProject({ cwd: directory, trustStore: store, ...asker, ...createOutput() }),
    ).resolves.toBeUndefined();

    expect(asker.asked).toEqual([]);
  });
});

describe("trustCreatedProject", () => {
  it("records the project of the current directory", async () => {
    const store = createTrustStore(() => file);

    await trustCreatedProject({ cwd: root, trustStore: store, ...createOutput() });

    expect(store.has(root)).toBe(true);
  });

  it("warns when the record cannot be written", async () => {
    chmodSync(directory, 0o500);
    const output = createOutput();

    await trustCreatedProject({ cwd: root, trustStore: createTrustStore(() => file), ...output });

    expect(output.written.stderr).toMatch(
      /^ugoke: could not record that the project is trusted, so the next command asks: EACCES/u,
    );
  });
});
