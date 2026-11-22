import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureTemporalCli } from "./download.ts";
import type { TemporalCliManifest } from "./types.ts";

const platform = "linux-x64";

describe("ensureTemporalCli", () => {
  let root: string;
  let archive: Buffer;
  let manifest: TemporalCliManifest;
  let requests: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ugoke-temporal-cli-"));
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "temporal"), "#!/bin/sh\necho fake temporal\n");
    execFileSync("tar", ["-czf", join(root, "release.tar.gz"), "-C", source, "temporal"]);
    archive = readFileSync(join(root, "release.tar.gz"));
    const asset = {
      file: "temporal_cli_9.9.9_linux_amd64.tar.gz",
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
    manifest = {
      assets: {
        "darwin-arm64": asset,
        "darwin-x64": asset,
        "linux-arm64": asset,
        "linux-x64": asset,
      },
      version: "9.9.9",
    };
    requests = [];
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const fetchArchive = async (url: string): Promise<Response> => {
    requests.push(url);
    return new Response(archive);
  };

  const cacheDirectory = () => join(root, "cache");

  it("downloads, verifies, and caches the pinned release", async () => {
    const downloads: string[] = [];
    const options = {
      cacheDirectory: cacheDirectory(),
      fetch: fetchArchive,
      manifest,
      onDownload: (version: string) => downloads.push(version),
      platform,
    };

    const executable = await ensureTemporalCli(options);

    expect(executable).toBe(join(cacheDirectory(), "9.9.9", platform, "temporal"));
    expect(execFileSync(executable, { encoding: "utf8" })).toBe("fake temporal\n");
    expect(statSync(executable).mode & 0o777).toBe(0o755);
    expect(requests).toEqual([
      "https://github.com/temporalio/cli/releases/download/v9.9.9/temporal_cli_9.9.9_linux_amd64.tar.gz",
    ]);

    await expect(ensureTemporalCli(options)).resolves.toBe(executable);
    expect(requests).toHaveLength(1);
    expect(downloads).toEqual(["9.9.9"]);
  });

  it("rejects an archive with a different checksum and keeps nothing", async () => {
    const tampered = {
      ...manifest,
      assets: {
        ...manifest.assets,
        [platform]: { ...manifest.assets[platform], sha256: "0".repeat(64) },
      },
    };

    await expect(
      ensureTemporalCli({
        cacheDirectory: cacheDirectory(),
        fetch: fetchArchive,
        manifest: tampered,
        platform,
      }),
    ).rejects.toThrow("Checksum mismatch");
    expect(existsSync(join(cacheDirectory(), "9.9.9"))).toBe(false);
    expect(readdirSync(cacheDirectory())).toEqual([]);
  });

  it("removes work directories left by a stopped process", async () => {
    const stale = join(cacheDirectory(), ".download-stale");
    const recent = join(cacheDirectory(), ".download-recent");
    mkdirSync(stale, { recursive: true });
    mkdirSync(recent);
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, dayAgo, dayAgo);

    await ensureTemporalCli({
      cacheDirectory: cacheDirectory(),
      fetch: fetchArchive,
      manifest,
      platform,
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("stops the download when aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      ensureTemporalCli({
        cacheDirectory: cacheDirectory(),
        fetch: async (_url, { signal }) => {
          signal?.throwIfAborted();
          return new Response(archive);
        },
        manifest,
        platform,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(cacheDirectory(), "9.9.9"))).toBe(false);
  });

  it("reports a failed download", async () => {
    await expect(
      ensureTemporalCli({
        cacheDirectory: cacheDirectory(),
        fetch: async () => new Response(null, { status: 404 }),
        manifest,
        platform,
      }),
    ).rejects.toThrow("404");
  });

  it("rejects an unsupported platform", async () => {
    await expect(
      ensureTemporalCli({
        cacheDirectory: cacheDirectory(),
        fetch: fetchArchive,
        manifest,
        platform: "win32-x64",
      }),
    ).rejects.toThrow("Start ugoke daemon with --address");
    expect(requests).toEqual([]);
  });
});
