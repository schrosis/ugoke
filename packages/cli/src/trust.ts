import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { cancelledExitCode } from "./exit-codes.js";
import { stateDirectory } from "./state.js";
import { findProjectRoot } from "./workflows.js";

/** How the user answered whether to trust a project. */
export type TrustAnswer = "interrupted" | "no" | "yes";

/** The project roots that the user trusts. */
export interface TrustStore {
  /**
   * Returns whether the record has the root. A record that does not exist yet has no root.
   *
   * @throws {TrustRecordError} When the record cannot be read.
   */
  has: (root: string) => boolean;
  /**
   * Adds the root to the record.
   *
   * @throws {TrustRecordError} When the record cannot be read, so that it is not replaced.
   * @throws When the record cannot be written.
   */
  add: (root: string) => void;
}

/** What a command needs to ask whether to trust a project. */
export interface TrustContext {
  cwd: string;
  stderr: (text: string) => void;
  /**
   * Asks the user whether to trust the project at a root. It is absent when nobody can answer,
   * such as with a pipe or in CI.
   */
  askTrust?: ((root: string) => Promise<TrustAnswer>) | undefined;
  /** The record of trusted roots. Without it, no command asks, and `ugoke init` records nothing. */
  trustStore?: TrustStore | undefined;
}

/** A trust record that exists but cannot be read, such as one that was edited into broken JSON. */
export class TrustRecordError extends Error {
  override name = "TrustRecordError";
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Reads the roots of the record.
 *
 * A broken record is not read as an empty one, because the next root that is added would then
 * replace the roots of every other project without telling why they were asked about again.
 */
const readRoots = (file: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw new TrustRecordError(
      `The trust record ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}. Fix the file, or delete it to be asked about each project again`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((root) => typeof root === "string")) {
    throw new TrustRecordError(
      `The trust record ${file} cannot be read: it is not a list of paths. Fix the file, or delete it to be asked about each project again`,
    );
  }
  return parsed;
};

/**
 * Creates the record of trusted roots in a file, which holds a JSON array of real paths.
 *
 * @param file Returns the path of the file. It is called only when the record is used, so that a
 *   command that never asks does not create the state directory.
 */
export const createTrustStore = (
  file: () => string = () => join(stateDirectory(), "trusted-projects.json"),
): TrustStore => ({
  add: (root) => {
    const path = file();
    const roots = readRoots(path);
    if (roots.includes(root)) {
      return;
    }
    // The file is replaced at once, so that a command that reads it meanwhile gets a whole record.
    // Nothing locks the record between reading and replacing it: when two commands add a root at
    // the same time, one root can be lost, and the next command of its project asks again.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify([...roots, root], null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      // After the rename, there is nothing to remove.
      rmSync(temporary, { force: true });
    }
  },
  has: (root) => readRoots(file()).includes(root),
});

/**
 * Asks whether to trust the project of the current directory before a command reads it, unless
 * the user trusted it before.
 *
 * A command reads the configuration file and the definitions of its project, and runs its plugins
 * in this process, so a project that someone else prepared could run their code as the user.
 * When nobody can answer, such as with `--from-ai`, a pipe, or in CI, the command goes on without
 * asking, and the record is neither read nor written. A record that cannot be read ends the
 * command before it asks.
 *
 * @param fromAi Whether a program runs the command, which cannot answer.
 * @returns The exit code to end the command with, or `undefined` when the command goes on.
 */
export const ensureTrustedProject = async (
  context: TrustContext,
  fromAi = false,
): Promise<number | undefined> => {
  const { askTrust, trustStore } = context;
  if (fromAi || askTrust === undefined || trustStore === undefined) {
    return undefined;
  }
  const found = await findProjectRoot(context.cwd);
  if (found === undefined) {
    // The command reports that there is no project.
    return undefined;
  }
  const root = await realpath(found);
  try {
    if (trustStore.has(root)) {
      return undefined;
    }
  } catch (error) {
    if (!(error instanceof TrustRecordError)) {
      throw error;
    }
    // Asking would end in a record that cannot be written, so the command ends before it asks.
    context.stderr(`ugoke: ${error.message}\n`);
    return 1;
  }
  const answer = await askTrust(root);
  if (answer === "interrupted") {
    return cancelledExitCode;
  }
  if (answer === "no") {
    context.stderr(`ugoke: ${root} is not trusted, so nothing in it was read\n`);
    return 1;
  }
  try {
    trustStore.add(root);
  } catch (error) {
    context.stderr(
      `ugoke: could not record that ${root} is trusted, so nothing in it was read: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  return undefined;
};

/**
 * Records that the user trusts a project that `ugoke init` created, so that the next command
 * does not ask.
 *
 * A record that cannot be read or written only warns, because the project is created, and the
 * next command asks or reports the record instead.
 */
export const trustCreatedProject = async (context: TrustContext): Promise<void> => {
  if (context.trustStore === undefined) {
    return;
  }
  try {
    context.trustStore.add(await realpath(context.cwd));
  } catch (error) {
    context.stderr(
      `ugoke: could not record that the project is trusted, so the next command asks: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
};
