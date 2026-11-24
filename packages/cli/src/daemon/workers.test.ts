import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StartWorkerOptions } from "@ugoke/engine";
import { workflowCodeVersion } from "@ugoke/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectTaskQueue } from "../state.ts";
import { createProjectWorkers, WorkersStoppedError } from "./workers.ts";

const succeed = async () => ({ stop: async () => {} });

describe("createProjectWorkers", () => {
  let directory: string;
  let file: string;
  let project: string;
  let started: StartWorkerOptions[];
  let lines: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ugoke-workers-"));
    file = join(directory, "projects.json");
    project = join(directory, "project");
    mkdirSync(join(project, ".ugoke"), { recursive: true });
    started = [];
    lines = [];
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  const create = (start: (options: StartWorkerOptions) => Promise<{ stop: () => Promise<void> }>) =>
    createProjectWorkers({
      address: "127.0.0.1:7233",
      file,
      log: (message) => lines.push(message),
      prepareEngine: () => {},
      // The tests wait for the attempts that follow a failure.
      retryDelayMs: { first: 10, longest: 40 },
      startWorker: async (options) => {
        started.push(options);
        return start(options);
      },
    });

  it("serves a project on its versioned task queue and keeps it in the file", async () => {
    const workers = create(succeed);

    await expect(workers.add(project)).resolves.toEqual({
      address: "127.0.0.1:7233",
      root: project,
      taskQueue: projectTaskQueue(project),
    });
    expect(projectTaskQueue(project)).toMatch(new RegExp(`-v${workflowCodeVersion}$`, "u"));
    expect(started.map(({ taskQueue }) => taskQueue)).toEqual([projectTaskQueue(project)]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([project]);

    await workers.add(project);
    expect(started).toHaveLength(1);
  });

  it("gives the Worker the wait methods of the plugins, which answer in the Worker", async () => {
    await create(succeed).add(project);

    // The registry has the built-in methods, which methods of the project join.
    expect(started[0]?.plugins?.waitMethodNames()).toEqual(["terminal"]);
    // The resident process has no terminal, so the terminal does not answer there.
    expect(started[0]?.plugins?.waitMethod("terminal")).not.toHaveProperty("respond");
  });

  it("writes what the Worker logs to the log of the resident process, with the project", async () => {
    await create(succeed).add(project);
    lines = [];

    started[0]?.log?.("steps.review: Failed to read the comments");

    expect(lines).toEqual([`${project}: steps.review: Failed to read the comments`]);
  });

  it("rejects a directory without .ugoke", async () => {
    await expect(create(succeed).add(directory)).rejects.toThrow("has no .ugoke directory");
  });

  it("keeps a project whose Worker cannot start yet, and drops one that was removed", async () => {
    const missing = join(directory, "missing");
    writeFileSync(file, JSON.stringify([project, missing]));
    const workers = create(async () => Promise.reject(new Error("server unreachable")));

    await workers.restore();

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([project]);
    expect(workers.list()).toEqual([
      {
        address: "127.0.0.1:7233",
        root: project,
        running: false,
        taskQueue: projectTaskQueue(project),
      },
    ]);
  });

  it("starts a Worker again by itself after it failed", async () => {
    const workers = create(async (options) => {
      // The first Worker fails after it started.
      if (started.length === 1) {
        setImmediate(() => options.onError?.(new Error("connection lost")));
      }
      return { stop: async () => {} };
    });
    await workers.add(project);
    await new Promise((resolve) => setImmediate(resolve));

    expect(workers.list()).toMatchObject([{ running: false }]);
    expect(lines).toContain(
      `Worker of ${project} failed: connection lost. Trying again in 0.01 seconds`,
    );
    // No command asks for the project again.
    await vi.waitFor(() => expect(workers.list()).toMatchObject([{ running: true }]));
    expect(started).toHaveLength(2);
    await workers.stopAll();
  });

  it("keeps trying to start a Worker, with longer waits up to the longest, until it starts", async () => {
    writeFileSync(file, JSON.stringify([project]));
    const workers = create(async () => {
      if (started.length <= 4) {
        throw new Error("server unreachable");
      }
      return { stop: async () => {} };
    });

    await workers.restore();
    await vi.waitFor(() => expect(workers.list()).toMatchObject([{ running: true }]));

    expect(started).toHaveLength(5);
    expect(lines.filter((line) => line.startsWith("cannot serve"))).toEqual(
      [0.01, 0.02, 0.04, 0.04].map(
        (seconds) =>
          `cannot serve ${project} yet: server unreachable. Trying again in ${seconds} seconds`,
      ),
    );
    await workers.stopAll();
  });

  it("starts with the first wait again after a Worker ran", async () => {
    let fail = true;
    const workers = create(async () => {
      if (fail) {
        throw new Error("server unreachable");
      }
      return { stop: async () => {} };
    });
    await expect(workers.add(project)).rejects.toThrow("server unreachable");
    await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(3));
    fail = false;
    await vi.waitFor(() => expect(workers.list()).toMatchObject([{ running: true }]));
    lines = [];

    started.at(-1)?.onError?.(new Error("connection lost"));

    expect(lines).toEqual([
      `Worker of ${project} failed: connection lost. Trying again in 0.01 seconds`,
    ]);
    await workers.stopAll();
  });

  it("does not try again after it was asked to stop", async () => {
    const workers = create(async () => Promise.reject(new Error("server unreachable")));
    await expect(workers.add(project)).rejects.toThrow("server unreachable");

    await workers.stopAll();
    const attempts = started.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(started).toHaveLength(attempts);
  });

  it("stops trying for a project that was removed", async () => {
    const workers = create(async () => Promise.reject(new Error("server unreachable")));
    await expect(workers.add(project)).rejects.toThrow("server unreachable");

    rmSync(join(project, ".ugoke"), { recursive: true });
    await vi.waitFor(() =>
      expect(lines).toContain(
        `stopped trying to serve ${project}, because it has no .ugoke directory`,
      ),
    );
    const attempts = started.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(started).toHaveLength(attempts);
  });

  it("starts the Workers of the kept projects at once, and lists them before they run", async () => {
    const other = join(directory, "other");
    mkdirSync(join(other, ".ugoke"), { recursive: true });
    writeFileSync(file, JSON.stringify([project, other]));
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const workers = create(async () => {
      await released;
      return { stop: async () => {} };
    });

    const restored = workers.restore();

    expect(workers.list().map(({ root }) => root)).toEqual([project, other]);
    // Neither waits for the other to start.
    await vi.waitFor(() => expect(started).toHaveLength(2));
    release();
    await restored;
    expect(workers.list()).toMatchObject([{ running: true }, { running: true }]);
  });

  it("reads the encryption key before it prepares the engine, and tries again after the key is fixed", async () => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = directory;
    try {
      mkdirSync(join(directory, "ugoke"), { mode: 0o700 });
      const key = join(directory, "ugoke", "encryption.key");
      writeFileSync(key, "broken\n", { mode: 0o600 });
      let prepared = 0;
      const workers = createProjectWorkers({
        address: "127.0.0.1:7233",
        file,
        log: (message) => lines.push(message),
        // A process with a prepared engine does not exit by itself until it reaches the server.
        prepareEngine: () => {
          prepared += 1;
        },
        startWorker: async (options) => {
          started.push(options);
          return succeed();
        },
      });

      await expect(workers.add(project)).rejects.toThrow("The encryption key in");
      expect(prepared).toBe(0);
      expect(started).toEqual([]);

      rmSync(key);
      await workers.add(project);
      expect(prepared).toBe(1);
      expect(started).toHaveLength(1);
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previous;
      }
    }
  });

  it("runs the Worker on the server that the project names", async () => {
    writeFileSync(
      join(project, ".ugoke", "config.yaml"),
      "temporal:\n  address: temporal.example.com:7233\n",
    );
    const workers = create(succeed);

    await expect(workers.add(project)).resolves.toMatchObject({
      address: "temporal.example.com:7233",
    });
    expect(started.map(({ address }) => address)).toEqual(["temporal.example.com:7233"]);
    expect(workers.list()).toMatchObject([{ address: "temporal.example.com:7233", running: true }]);
  });

  it("moves to the server that the project names now, and keeps the previous Worker until it stops", async () => {
    const stopped: string[] = [];
    const workers = create(async ({ address }) => ({
      stop: async () => {
        stopped.push(address);
      },
    }));
    await workers.add(project);

    writeFileSync(
      join(project, ".ugoke", "config.yaml"),
      "temporal:\n  address: temporal.example.com:7233\n",
    );
    await workers.add(project);
    await workers.add(project);

    expect(started.map(({ address }) => address)).toEqual([
      "127.0.0.1:7233",
      "temporal.example.com:7233",
    ]);
    expect(stopped).toEqual([]);
    expect(workers.list()).toMatchObject([
      {
        address: "temporal.example.com:7233",
        previousAddresses: ["127.0.0.1:7233"],
        running: true,
      },
    ]);
    await workers.stopAll();
    expect(stopped.toSorted()).toEqual(["127.0.0.1:7233", "temporal.example.com:7233"]);
  });

  it("does not start the Worker on a previous server again after it failed", async () => {
    const workers = create(succeed);
    await workers.add(project);
    writeFileSync(
      join(project, ".ugoke", "config.yaml"),
      "temporal:\n  address: temporal.example.com:7233\n",
    );
    await workers.add(project);

    started[0]?.onError?.(new Error("connection lost"));

    expect(lines).toContain(
      `Worker of ${project} at 127.0.0.1:7233 failed: connection lost. It is not started again, because the project does not use it now`,
    );
    // Longer than the first wait.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toHaveLength(2);
    expect(workers.list()).toEqual([
      expect.not.objectContaining({ previousAddresses: expect.anything() }),
    ]);
    expect(workers.list()).toMatchObject([{ address: "temporal.example.com:7233", running: true }]);
    await workers.stopAll();
  });

  it("does not start a Worker again after the one that stops for new plugins failed", async () => {
    const workers = create(succeed);
    await workers.add(project);
    // ugoke has this plugin built in, so adding it changes the list without loading a package.
    writeFileSync(
      join(project, ".ugoke", "config.yaml"),
      'plugins:\n  "@ugoke/adapter-ai-claude-code":\n',
    );
    await workers.add(project);
    const count = started.length;
    expect(count).toBe(2);

    started[0]?.onError?.(new Error("connection lost"));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toHaveLength(count);
    expect(workers.list()).toMatchObject([{ running: true }]);
    expect(lines.filter((line) => line.includes("Trying again"))).toEqual([]);
    await workers.stopAll();
  });

  it("uses the Worker on a server again when the project names it again", async () => {
    const workers = create(succeed);
    const config = join(project, ".ugoke", "config.yaml");
    await workers.add(project);
    writeFileSync(config, "temporal:\n  address: temporal.example.com:7233\n");
    await workers.add(project);
    rmSync(config);

    await expect(workers.add(project)).resolves.toMatchObject({ address: "127.0.0.1:7233" });
    expect(started.map(({ address }) => address)).toEqual([
      "127.0.0.1:7233",
      "temporal.example.com:7233",
    ]);
    expect(workers.list()).toMatchObject([
      { address: "127.0.0.1:7233", previousAddresses: ["temporal.example.com:7233"] },
    ]);
  });

  it("starts one Worker for concurrent requests of a project", async () => {
    const workers = create(succeed);

    await Promise.all([workers.add(project), workers.add(project), workers.restore()]);

    expect(started).toHaveLength(1);
  });

  it("rejects a project whose configuration file is invalid", async () => {
    writeFileSync(join(project, ".ugoke", "config.yaml"), "temporal:\n  port: 7233\n");

    await expect(create(succeed).add(project)).rejects.toThrow("Unknown field: port");
    expect(started).toEqual([]);
  });

  it("starts the Worker again when the plugins of the project change, and stops the previous one", async () => {
    const stopped: number[] = [];
    const workers = create(async () => {
      const index = started.length;
      return {
        stop: async () => {
          stopped.push(index);
        },
      };
    });
    const config = join(project, ".ugoke", "config.yaml");
    await workers.add(project);
    await workers.add(project);
    expect(started).toHaveLength(1);

    // ugoke has this plugin built in, so adding it changes the list without loading a package.
    writeFileSync(config, 'plugins:\n  "@ugoke/adapter-ai-claude-code":\n');
    await workers.add(project);
    await new Promise((resolve) => setImmediate(resolve));

    expect(started).toHaveLength(2);
    expect(stopped).toEqual([1]);
    expect(workers.list()).toMatchObject([{ running: true }]);
    await workers.stopAll();
    expect(stopped).toEqual([1, 2]);
  });

  it("keeps the previous Worker when the Worker with the new plugins cannot start", async () => {
    const stopped: number[] = [];
    const workers = create(async () => {
      const index = started.length;
      return {
        stop: async () => {
          stopped.push(index);
        },
      };
    });
    await workers.add(project);

    writeFileSync(join(project, ".ugoke", "config.yaml"), 'plugins:\n  "@acme/ugoke-missing":\n');
    await expect(workers.add(project)).rejects.toThrow(
      "Plugin @acme/ugoke-missing is not installed",
    );

    expect(stopped).toEqual([]);
    expect(workers.list()).toMatchObject([{ running: true }]);
    await workers.stopAll();
    expect(stopped).toEqual([1]);
  });

  it("adds no project after it was asked to stop", async () => {
    const workers = create(succeed);
    await workers.stopAll();

    await expect(workers.add(project)).rejects.toThrow(new WorkersStoppedError());
    expect(started).toEqual([]);
  });

  it("stops the Worker of a request that came just before it was asked to stop", async () => {
    const stops: string[] = [];
    const workers = create(async ({ taskQueue }) => ({
      stop: async () => {
        stops.push(taskQueue);
      },
    }));

    // The Worker starts only after the request read the configuration file.
    const added = workers.add(project);
    await workers.stopAll();

    await expect(added).resolves.toMatchObject({ root: project });
    expect(stops).toEqual([projectTaskQueue(project)]);
  });

  it("starts the Worker again when the settings of a plugin change", async () => {
    const config = join(project, ".ugoke", "config.yaml");
    const plugin = join(project, "node_modules", "ugoke-settings");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(plugin, "package.json"),
      '{"name":"ugoke-settings","type":"module","main":"index.js"}',
    );
    writeFileSync(
      join(plugin, "index.js"),
      'export default { name: "settings", config: { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) } } };\n',
    );
    const workers = create(succeed);

    writeFileSync(config, "plugins:\n  ugoke-settings:\n    level: 1\n");
    await workers.add(project);
    await workers.add(project);
    writeFileSync(config, "plugins:\n  ugoke-settings:\n    level: 2\n");
    await workers.add(project);

    expect(started).toHaveLength(2);
  });
});
