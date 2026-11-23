import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { cancelledExitCode } from "./exit-codes.js";
import { stateDirectory } from "./state.js";
import { findProjectRoot } from "./workflows.js";

/** How the user answered whether to trust a project. */
export type TrustAnswer = "interrupted" | "no" | "yes";

/** The project roots that the user trusts. */
export interface TrustStore {
  /** Returns whether the record has the root. A record that cannot be read has no root. */
  has: (root: string) => boolean;
  /**
   * Adds the root to the record.
   *
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

const readRoots = (file: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((root) => typeof root === "string") : [];
  } catch {
    return [];
  }
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
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...roots, root], null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
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
 * asking, and the record is neither read nor written.
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
  if (trustStore.has(root)) {
    return undefined;
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
 * A record that cannot be written only warns, because the project is created, and the next
 * command asks instead.
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
