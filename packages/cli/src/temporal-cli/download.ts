import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { ensurePrivateDirectory } from "../private-directory.js";
import { temporalCliManifest } from "./manifest.js";
import type { TemporalCliManifest, TemporalCliPlatform } from "./types.js";

const execFileAsync = promisify(execFile);

/** Options of {@link ensureTemporalCli}. */
export interface EnsureTemporalCliOptions {
  /** Directory that keeps downloaded releases. Defaults to {@link defaultCacheDirectory}. */
  cacheDirectory?: string;
  /** Release to download. Defaults to the pinned release. */
  manifest?: TemporalCliManifest;
  /** Platform as `<platform>-<arch>` of Node.js. Defaults to the current platform. */
  platform?: string;
  /** Function that downloads a URL. Defaults to the global `fetch`. */
  fetch?: (url: string, init: { signal: AbortSignal | null }) => Promise<Response>;
  /** Stops the download when aborted. */
  signal?: AbortSignal | undefined;
  /** Called before the release is downloaded, which happens only when it is not cached. */
  onDownload?: (version: string) => void;
}

/**
 * Returns the directory that keeps downloaded Temporal CLI releases, creating its parent when
 * needed.
 *
 * A cached release runs without its checksum being checked again, so the cache must be a
 * directory that only the user can use.
 *
 * @throws {UnsafeDirectoryError} When other users could use or replace the cache directory.
 */
export const defaultCacheDirectory = (): string =>
  join(
    ensurePrivateDirectory(
      join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ugoke"),
      "cache directory",
    ),
    "temporal-cli",
  );

const isPlatform = (
  manifest: TemporalCliManifest,
  platform: string,
): platform is TemporalCliPlatform => Object.hasOwn(manifest.assets, platform);

const workPrefix = ".download-";

/**
 * Age after which a work directory is treated as left by a stopped process.
 *
 * A download in another process takes far less time, so its directory is never removed.
 */
const staleWorkMs = 24 * 60 * 60 * 1000;

/** Removes work directories that a stopped process could not remove. */
const removeStaleWork = async (cacheDirectory: string): Promise<void> => {
  const entries = await readdir(cacheDirectory);
  await Promise.all(
    entries
      .filter((name) => name.startsWith(workPrefix))
      .map(async (name) => {
        const path = join(cacheDirectory, name);
        const { mtimeMs } = await stat(path);
        if (Date.now() - mtimeMs > staleWorkMs) {
          await rm(path, { force: true, recursive: true });
        }
      }),
  ).catch(() => {
    // Cleaning up is best effort and must not prevent the download.
  });
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Downloads a URL to a file and returns the SHA-256 of the content, in hexadecimal. */
const download = async (
  fetchUrl: NonNullable<EnsureTemporalCliOptions["fetch"]>,
  url: string,
  file: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const response = await fetchUrl(url, { signal: signal ?? null });
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(response.body),
    // A generator function is the form that stream pipelines accept for transforms.
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(file, { mode: 0o600 }),
  );
  return hash.digest("hex");
};

/**
 * Returns the path of the pinned Temporal CLI, downloading it on first use.
 *
 * The archive is verified against the pinned SHA-256 before it is extracted, so that a
 * tampered or unexpected release is never run.
 */
export const ensureTemporalCli = async ({
  cacheDirectory = defaultCacheDirectory(),
  fetch: fetchUrl = fetch,
  manifest = temporalCliManifest,
  onDownload,
  signal,
  platform = `${process.platform}-${process.arch}`,
}: EnsureTemporalCliOptions = {}): Promise<string> => {
  if (!isPlatform(manifest, platform)) {
    throw new Error(
      `Temporal CLI is not available for ${platform}. Start ugoke daemon with --address of a Temporal Server`,
    );
  }
  const asset = manifest.assets[platform];
  const directory = join(cacheDirectory, manifest.version, platform);
  const executable = join(directory, "temporal");
  if (await exists(executable)) {
    return executable;
  }

  onDownload?.(manifest.version);
  await mkdir(cacheDirectory, { mode: 0o700, recursive: true });
  await removeStaleWork(cacheDirectory);
  // Work in a temporary directory, so that an interrupted download is never used.
  const work = await mkdtemp(join(cacheDirectory, workPrefix));
  try {
    const archive = join(work, asset.file);
    const url = `https://github.com/temporalio/cli/releases/download/v${manifest.version}/${asset.file}`;
    const sha256 = await download(fetchUrl, url, archive, signal);
    if (sha256 !== asset.sha256) {
      throw new Error(
        `Checksum mismatch for ${asset.file}: expected ${asset.sha256}, received ${sha256}`,
      );
    }

    const extracted = join(work, "extracted");
    await mkdir(extracted);
    await execFileAsync("tar", ["-xzf", archive, "-C", extracted, "temporal"]);
    await chmod(join(extracted, "temporal"), 0o755);

    await mkdir(join(cacheDirectory, manifest.version), { recursive: true });
    // Another process may have installed the same release in the meantime.
    await rename(extracted, directory).catch(async (error: unknown) => {
      if (!(await exists(executable))) {
        throw error;
      }
    });
    return executable;
  } finally {
    await rm(work, { force: true, recursive: true });
  }
};
