import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import type { Intermediate } from "@ugoke/core";
import { compileDefinition } from "@ugoke/definition";
import type { DefinitionError } from "@ugoke/definition";

import { createRegistry, loadProjectPlugins, missingHint } from "../plugins.js";
import type { TrustAnswer, TrustStore } from "../trust.js";
import { resolveWorkflow } from "../workflows.js";

/** Environment that a command runs in. */
export interface CommandContext {
  cwd: string;
  /**
   * Returns the width of standard output when it is a terminal, which can show a status line.
   * It is absent for a pipe or a file.
   */
  columns?: (() => number) | undefined;
  /** Whether to color the text of each stream, such as for a terminal that has colors. */
  colors?: Readonly<Record<"stderr" | "stdout", boolean>> | undefined;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Returns the stream that wait steps read answers from.
   *
   * It is a function so that commands that do not read it never open standard input.
   */
  stdin?: () => NodeJS.ReadableStream;
  /**
   * Interrupts the command as SIGINT does. Interactive prompts read Ctrl+C as a key, so they
   * call it instead. Without it, the prompts are not used.
   */
  interrupt?: (() => void) | undefined;
  /**
   * Asks the user whether to trust the project at a root. It is absent when nobody can answer,
   * such as with a pipe or in CI.
   */
  askTrust?: ((root: string) => Promise<TrustAnswer>) | undefined;
  /** The record of trusted roots. Without it, no command asks, and `ugoke init` records nothing. */
  trustStore?: TrustStore | undefined;
}

/** A workflow that passed validation. */
export interface LoadedWorkflow {
  /** Project root, the directory that contains `.ugoke`. */
  root: string;
  /** Path of the definition file. */
  file: string;
  intermediate: Intermediate;
}

const formatPath = (path: readonly (number | string)[]): string =>
  path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`))
    .join("")
    .slice(1);

/** Formats a problem in a YAML file, such as `.ugoke/workflows/a.yaml:3:5 steps.a.run: message`. */
export const formatError = (
  file: string,
  { column, line, message, path }: DefinitionError,
): string => {
  const location = path.length > 0 ? ` ${formatPath(path)}:` : "";
  return `${file}:${line}:${column}${location} ${message}\n`;
};

/**
 * Resolves, reads, and compiles a workflow, writing any errors to standard error.
 *
 * @returns The compiled workflow, or `undefined` when it cannot be used.
 */
export const loadWorkflow = async (
  name: string,
  context: CommandContext,
): Promise<LoadedWorkflow | undefined> => {
  const resolved = await resolveWorkflow(context.cwd, name);
  if (!resolved.ok) {
    context.stderr(`${resolved.message}\n`);
    return undefined;
  }

  const file = relative(context.cwd, resolved.file);
  let source: string;
  try {
    source = await readFile(resolved.file, "utf8");
  } catch (error) {
    context.stderr(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }

  let plugins;
  try {
    plugins = createRegistry(undefined, await loadProjectPlugins(resolved.root, context.cwd));
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }

  const result = compileDefinition(source, { missingHint, plugins });
  if (!result.ok) {
    for (const error of result.errors) {
      context.stderr(formatError(file, error));
    }
    return undefined;
  }

  return { file: resolved.file, intermediate: result.intermediate, root: resolved.root };
};
