import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";

import { workflowCodeVersion } from "@ugoke/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "../testing.ts";
import { connectDaemon, DaemonUnavailableError, openCommandServer } from "./connect.ts";
import { daemonPaths } from "./paths.ts";

/** Opens the server of a command for a project without server options. */
const open = async (root: string, output = createOutput(), detach = false) =>
  openCommandServer({ detach, version: "1.2.3" }, root, { cwd: root, ...output });

describe("connectDaemon", () => {
  let state: string;
  let previous: string | undefined;
  let server: Server | undefined;
  const requests: { method: string | undefined; url: string | undefined; body: string }[] = [];

  beforeEach(() => {
    // A short directory keeps the socket path within the limit of the platform.
    state = mkdtempSync("/tmp/ugoke-connect-");
    previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    requests.length = 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    server = undefined;
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
    rmSync(state, { force: true, recursive: true });
  });

  /**
   * Serves a fake resident process that reports a version.
   *
   * @param projectAddress Server that it reports for the projects that it serves.
   * @param reported What its status reports besides the version.
   */
  const serve = async (
    version: string,
    projectAddress = "127.0.0.1:7233",
    reported: { projects?: unknown[]; workflowCodeVersion?: number } = {},
  ): Promise<void> => {
    const paths = daemonPaths();
    mkdirSync(paths.directory, { recursive: true });
    server = createServer((incoming, response) => {
      let body = "";
      incoming.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      incoming.on("end", () => {
        requests.push({ body, method: incoming.method, url: incoming.url });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            incoming.url === "/status"
              ? {
                  address: "127.0.0.1:7233",
                  pid: 1,
                  projects: reported.projects ?? [],
                  serverOptions: "",
                  startedAt: "",
                  version,
                  workflowCodeVersion: reported.workflowCodeVersion ?? workflowCodeVersion,
                }
              : { address: projectAddress, root: "/project", taskQueue: "ugoke-host-hash" },
          ),
        );
      });
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(paths.socket, resolve));
  };

  it("registers the project with a resident process of the same version", async () => {
    await serve("1.2.3");
    const output = createOutput();

    await expect(
      connectDaemon("/project", "1.2.3", { cwd: "/", ...output }),
    ).resolves.toMatchObject({
      project: { address: "127.0.0.1:7233", root: "/project", taskQueue: "ugoke-host-hash" },
      server: { address: "127.0.0.1:7233", options: "" },
    });
    expect(requests).toEqual([
      { body: "", method: "GET", url: "/status" },
      { body: JSON.stringify({ root: "/project" }), method: "POST", url: "/projects" },
    ]);
  });

  it("runs its own Worker on its server when the resident process has another version", async () => {
    await serve("0.9.0");
    const output = createOutput();

    await expect(connectDaemon("/project", "1.2.3", { cwd: "/", ...output })).resolves.toEqual({
      server: expect.objectContaining({ address: "127.0.0.1:7233", options: "" }) as unknown,
    });
    expect(output.written.stderr).toBe(
      'ugoke daemon: runs ugoke 0.9.0, and this is ugoke 1.2.3, so this command runs its own Worker. Run "ugoke daemon stop" and start it again to use it\n',
    );
    expect(requests.map(({ url }) => url)).toEqual(["/status"]);
  });

  it("tells the task queue that a resident process of another ugoke version still serves", async () => {
    await serve("0.9.0", "127.0.0.1:7233", {
      projects: [{ root: "/project", running: true, taskQueue: "ugoke-host-hash" }],
    });
    const output = createOutput();

    await expect(
      connectDaemon("/project", "1.2.3", { cwd: "/", ...output }),
    ).resolves.toMatchObject({ pollingTaskQueue: "ugoke-host-hash" });
    expect(output.written.stderr).toBe(
      'ugoke daemon: runs ugoke 0.9.0, and this is ugoke 1.2.3, so it goes on with only the runs on its task queue, and this command runs its own Worker for other runs. Run "ugoke daemon stop" and start it again to use it\n',
    );
    // It does not register the project, because the command does not hand new runs to it.
    expect(requests.map(({ url }) => url)).toEqual(["/status"]);
  });

  it("tells no task queue when the resident process has another workflow code version", async () => {
    await serve("0.9.0", "127.0.0.1:7233", {
      projects: [{ root: "/project", running: true, taskQueue: "ugoke-host-hash" }],
      workflowCodeVersion: workflowCodeVersion - 1,
    });

    await expect(
      connectDaemon("/project", "1.2.3", { cwd: "/", ...createOutput() }),
    ).resolves.not.toHaveProperty("pollingTaskQueue", expect.anything());
  });

  it("tells no task queue when the Worker of the project does not run", async () => {
    await serve("0.9.0", "127.0.0.1:7233", {
      projects: [{ root: "/project", running: false, taskQueue: "ugoke-host-hash" }],
    });

    await expect(
      connectDaemon("/project", "1.2.3", { cwd: "/", ...createOutput() }),
    ).resolves.not.toHaveProperty("pollingTaskQueue", expect.anything());
  });

  it("says that a detached run needs the resident process of the same version", async () => {
    await serve("0.9.0");
    const output = createOutput();

    await connectDaemon("/project", "1.2.3", { cwd: "/", ...output }, { detach: true });

    expect(output.written.stderr).toBe(
      'ugoke daemon: runs ugoke 0.9.0, and this is ugoke 1.2.3, so it cannot run a detached run. Run "ugoke daemon stop" and start it again to use it\n',
    );
  });

  it("tells a detached run to start the resident process when none runs", async () => {
    await expect(
      connectDaemon(
        join(state, "project"),
        "1.2.3",
        { cwd: "/", ...createOutput() },
        { detach: true },
      ),
    ).rejects.toThrow(
      'ugoke daemon is not running, and --detach needs it to run the steps. Run "ugoke daemon start"',
    );
  });

  it("tells how to choose a server when no resident process runs", async () => {
    const output = createOutput();

    await expect(
      connectDaemon(join(state, "project"), "1.2.3", { cwd: "/", ...output }),
    ).rejects.toThrow(new DaemonUnavailableError("is not running"));
    expect(output.written).toEqual({ stderr: "", stdout: "" });
  });

  const project = (address: string): string => {
    const root = join(state, "project");
    mkdirSync(join(root, ".ugoke"), { recursive: true });
    writeFileSync(join(root, ".ugoke", "config.yaml"), `temporal:\n  address: ${address}\n`);
    return root;
  };

  describe("with a project that names its Temporal Server", () => {
    it("runs its own Worker on the server without a resident process", async () => {
      await expect(open(project("temporal.example.com:7233"))).resolves.toEqual({
        server: expect.objectContaining({
          address: "temporal.example.com:7233",
          options: "",
        }) as unknown,
        servedTaskQueue: undefined,
      });
    });

    it("asks the resident process to run the steps on the server of the project", async () => {
      await serve("1.2.3", "temporal.example.com:7233");

      await expect(open(project("temporal.example.com:7233"))).resolves.toMatchObject({
        server: { address: "temporal.example.com:7233" },
        servedTaskQueue: "ugoke-host-hash",
      });
      expect(requests.map(({ url }) => url)).toEqual(["/status", "/projects"]);
    });

    it("runs its own Worker when the resident process serves the project elsewhere, and says why", async () => {
      // The configuration file changed after the resident process read it.
      await serve("1.2.3", "127.0.0.1:7233");
      const output = createOutput();

      await expect(open(project("temporal.example.com:7233"), output)).resolves.toMatchObject({
        server: { address: "temporal.example.com:7233" },
        servedTaskQueue: undefined,
      });
      expect(output.written.stderr).toBe(
        "ugoke daemon: serves the project at 127.0.0.1:7233, and temporal.address of the project is temporal.example.com:7233, so this command runs its own Worker\n",
      );
    });

    it("runs its own Worker when the resident process has another version, and says why", async () => {
      await serve("0.9.0");
      const output = createOutput();

      await expect(open(project("127.0.0.1:7233"), output)).resolves.toMatchObject({
        servedTaskQueue: undefined,
      });
      expect(output.written.stderr).toContain("runs ugoke 0.9.0, and this is ugoke 1.2.3");
    });

    it("says nothing when no resident process runs", async () => {
      const output = createOutput();

      await open(project("temporal.example.com:7233"), output);

      expect(output.written).toEqual({ stderr: "", stdout: "" });
    });

    it("tells a detached run why the resident process does not run the steps", async () => {
      const output = createOutput();

      await expect(open(project("temporal.example.com:7233"), output, true)).resolves.toMatchObject(
        { servedTaskQueue: undefined },
      );
      expect(output.written.stderr).toBe(
        'ugoke daemon: is not running, so it cannot run a detached run. Run "ugoke daemon start"\n',
      );

      await serve("1.2.3", "127.0.0.1:7233");
      const elsewhere = createOutput();
      await open(project("temporal.example.com:7233"), elsewhere, true);
      expect(elsewhere.written.stderr).toBe(
        "ugoke daemon: serves the project at 127.0.0.1:7233, and temporal.address of the project is temporal.example.com:7233, so it cannot run a detached run\n",
      );
    });

    it("prefers the options of the command", async () => {
      await expect(
        openCommandServer(
          { server: { address: "localhost:7233", type: "address" }, version: "1.2.3" },
          project("temporal.example.com:7233"),
          { cwd: "/", ...createOutput() },
        ),
      ).resolves.toMatchObject({ server: { address: "localhost:7233" } });
    });
  });
});
