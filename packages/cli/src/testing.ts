import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { temporalCliManifest } from "./temporal-cli/manifest.ts";

/** A project in the test fixtures that contains `.ugoke/workflows`. */
export const fixtureProject = fileURLToPath(new URL("../test/fixtures/project", import.meta.url));

/** Collects text written by a command. */
export const createOutput = () => {
  const written = { stderr: "", stdout: "" };
  return {
    stderr: (text: string) => {
      written.stderr += text;
    },
    stdout: (text: string) => {
      written.stdout += text;
    },
    written,
  };
};

/**
 * Puts a Temporal CLI in the cache directory of ugoke under `cacheHome`, where a download would
 * put it, so that the resident process of a test starts its development server without
 * downloading one.
 *
 * @param cacheHome Directory to pass as `XDG_CACHE_HOME`.
 * @param executable Temporal CLI of the pinned version, such as the one that the tests inject.
 */
export const seedTemporalCli = (cacheHome: string, executable: string): void => {
  const directory = join(
    cacheHome,
    "ugoke",
    "temporal-cli",
    temporalCliManifest.version,
    `${process.platform}-${process.arch}`,
  );
  mkdirSync(directory, { mode: 0o700, recursive: true });
  // The cache directory must be private, whatever the umask is.
  chmodSync(join(cacheHome, "ugoke"), 0o700);
  symlinkSync(executable, join(directory, "temporal"));
};
