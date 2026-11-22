import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { devServerArguments, startDevServer } from "./dev-server.ts";

const canConnect = async (address: string): Promise<boolean> => {
  const [host = "", port = ""] = address.split(":");
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
};

const freePort = async (): Promise<number> => {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  return typeof address === "object" && address !== null ? address.port : 0;
};

describe("startDevServer", () => {
  const executable = inject("temporalCli");
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ugoke-dev-server-"));
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("starts a server that accepts connections and stops it", async () => {
    const server = await startDevServer({ dbFilename: join(root, "start.db"), executable });

    expect(server.address).toMatch(/^127\.0\.0\.1:\d+$/u);
    await expect(canConnect(server.address)).resolves.toBe(true);

    await server.stop();
    await expect(canConnect(server.address)).resolves.toBe(false);
  }, 60_000);

  it("does not start the Web UI, which a web page could use to start a run", () => {
    const args = devServerArguments({ dbFilename: "temporal.db", httpPort: 7243, port: 7233 });

    expect(args).toContain("--headless");
    expect(args).not.toContain("--ui-port");
  });

  it("turns off the HTTP API, which a web page could use to start a run", async () => {
    const [port, httpPort] = await Promise.all([freePort(), freePort()]);
    const child = spawn(
      executable,
      devServerArguments({ dbFilename: join(root, "http.db"), httpPort, port }),
      {
        stdio: "ignore",
      },
    );
    try {
      const url = `http://127.0.0.1:${httpPort}/api/v1/namespaces/default/workflows/probe`;
      let response: Response | undefined;
      for (let attempt = 0; attempt < 150 && response === undefined; attempt += 1) {
        // A form or a plain text request needs no preflight, so any web page can send it.
        response = await fetch(url, {
          body: JSON.stringify({ taskQueue: { name: "probe" }, workflowType: { name: "ugoke" } }),
          headers: { "content-type": "text/plain" },
          method: "POST",
        }).catch(async () => {
          await sleep(200);
          return undefined;
        });
      }

      expect(response?.status).toBe(403);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  it("keeps the state in a SQLite file", async () => {
    const dbFilename = join(root, "temporal.db");
    const server = await startDevServer({ dbFilename, executable });
    await server.stop();

    expect(existsSync(dbFilename)).toBe(true);
  }, 60_000);

  it("retries once and reports a server that exits before it starts", async () => {
    const attempts = join(root, "attempts");
    const failing = join(root, "failing-temporal");
    writeFileSync(
      failing,
      `#!/bin/sh\necho attempt >> "${attempts}"\necho 'unknown flag' >&2\nexit 3\n`,
      { mode: 0o755 },
    );

    await expect(
      startDevServer({ dbFilename: join(root, "failing.db"), executable: failing }),
    ).rejects.toThrow("Temporal dev server exited with code 3:\nunknown flag");
    expect(readFileSync(attempts, "utf8")).toBe("attempt\nattempt\n");
  });

  it("stops waiting and stops the server when aborted", async () => {
    const pidFile = join(root, "pid");
    const hanging = join(root, "hanging-temporal");
    writeFileSync(hanging, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
    const controller = new AbortController();
    // Abort once the process has started, because starting it can take a while under load.
    const poll = setInterval(() => {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n")) {
        clearInterval(poll);
        controller.abort();
      }
    }, 50);

    await expect(
      startDevServer({
        dbFilename: join(root, "hanging.db"),
        executable: hanging,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reports a missing executable", async () => {
    await expect(
      startDevServer({ dbFilename: join(root, "missing.db"), executable: join(root, "missing") }),
    ).rejects.toThrow("Failed to start the Temporal CLI");
  });
});
