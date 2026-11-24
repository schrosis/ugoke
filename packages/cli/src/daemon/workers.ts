import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFileEventLog } from "@ugoke/adapter-event-log-file";
import { createLocalScriptRunner } from "@ugoke/adapter-script-local";
import { createAiRunner } from "@ugoke/core";
import { startWorker } from "@ugoke/engine";
import type { RunningWorker } from "@ugoke/engine";

import { readProjectConfig } from "../config.js";
import type { ReadProjectConfig } from "../config.js";
import { loadEncryptionKey } from "../encryption.js";
import { createEnvironmentReader } from "../environment.js";
import { createRegistry, loadConfiguredPlugins } from "../plugins.js";
import { projectLogDirectory, projectTaskQueue } from "../state.js";
import { ugokeDirectory } from "../workflows.js";
import type { DaemonProject } from "./client.js";

/** Options of {@link createProjectWorkers}. */
export interface ProjectWorkersOptions {
  /**
   * Address of the Temporal Server of the resident process, for the projects that do not name
   * theirs with `temporal.address` in `.ugoke/config.yaml`.
   */
  address: string;
  /** File that keeps the projects across restarts. */
  file: string;
  /** Writes a line to the log of the resident process. */
  log: (message: string) => void;
  /**
   * Prepares the workflow engine before the first Worker starts.
   *
   * A prepared engine keeps the process alive until its Workers stop, so it is prepared only
   * when a project needs a Worker.
   */
  prepareEngine: () => void;
  /** Starts a Worker. Defaults to `startWorker` of `@ugoke/engine`. */
  startWorker?: typeof startWorker;
  /**
   * Time before a Worker that failed is started again, in milliseconds. It doubles after each
   * failure up to the longest. Defaults to a second, and a minute at the longest.
   */
  retryDelayMs?: { first: number; longest: number };
}

/** Thrown when a project is added after the Workers were asked to stop. */
export class WorkersStoppedError extends Error {
  constructor() {
    super("ugoke daemon is stopping");
    this.name = "WorkersStoppedError";
  }
}

/** The Workers of the projects that the resident process serves. */
export interface ProjectWorkers {
  /**
   * Serves a project, starting its Worker unless it already runs on the server of the project.
   *
   * The configuration file of the project is read again, so that a Worker moves to the server
   * that the project names now.
   *
   * @throws {WorkersStoppedError} After {@link ProjectWorkers.stopAll} was called.
   */
  add: (root: string) => Promise<DaemonProject>;
  /**
   * Starts the Workers of the projects that the file keeps, at once. The projects are listed as
   * soon as it is called.
   */
  restore: () => Promise<void>;
  list: () => DaemonProject[];
  /**
   * Stops every Worker, after the scripts that they run finish. A request that came before is
   * finished first, so that the Worker that it starts stops too, and no project is added after.
   */
  stopAll: () => Promise<void>;
}

const readRoots = (file: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((root) => typeof root === "string") : [];
  } catch {
    return [];
  }
};

const isProject = (root: string): boolean => existsSync(join(root, ugokeDirectory));

/** Says when a Worker is started again, to end a line of the log. */
const again = (delayMs: number | undefined): string =>
  delayMs === undefined
    ? ""
    : `. Trying again in ${delayMs / 1000} ${delayMs === 1000 ? "second" : "seconds"}`;

/** A Worker of a project on a server, and the plugin packages that it loaded. */
interface ServedWorker {
  /** The plugin packages and their settings, as JSON, to compare with the configuration. */
  plugins: string;
  worker: Promise<RunningWorker>;
}

/**
 * Creates the Workers of projects, one for each project on the task queue of the project.
 *
 * Each Worker uses the Temporal Server that the project names, or that of the resident process.
 * Scripts run in the project root, and their progress goes to the log of the project.
 */
export const createProjectWorkers = ({
  address,
  file,
  log,
  prepareEngine,
  retryDelayMs = { first: 1000, longest: 60_000 },
  startWorker: startProjectWorker = startWorker,
}: ProjectWorkersOptions): ProjectWorkers => {
  // Projects to serve, which the file keeps also while their Workers cannot run.
  const roots = new Set<string>();
  // Workers that run or start, keyed by project root and then by server, so that a project gets
  // one Worker on each server. A Worker on a server that the project no longer names keeps
  // serving the runs that started there until the resident process stops.
  const workers = new Map<string, Map<string, ServedWorker>>();
  // Workers that stop because their plugins changed, after the scripts that they run finish.
  const stopping = new Set<Promise<void>>();
  // The server that each project names now.
  const servers = new Map<string, string>();
  // The latest request to serve each project. A request waits for the previous one, so that
  // concurrent requests start one Worker.
  const pending = new Map<string, Promise<string>>();
  // Whether the Workers were asked to stop, after which none may start.
  let stopped = false;
  // Projects whose Worker is started again later, and the time before the attempt after that.
  const retryTimers = new Map<string, NodeJS.Timeout>();
  const retryDelays = new Map<string, number>();

  const save = (): void => {
    writeFileSync(file, `${JSON.stringify([...roots], null, 2)}\n`, { mode: 0o600 });
  };

  const forget = (root: string, serverAddress: string, worker: Promise<RunningWorker>): void => {
    // A later Worker of the same project and server is kept.
    const byServer = workers.get(root);
    if (byServer?.get(serverAddress)?.worker === worker) {
      byServer.delete(serverAddress);
    }
  };

  /** Returns the Temporal Server and the plugins that a project names now. */
  const settingsOf = async (
    root: string,
  ): Promise<{ serverAddress: string; plugins: string; read: ReadProjectConfig }> => {
    const read = await readProjectConfig(root, root);
    return {
      // The order of the plugins and their settings are compared, because both affect names.
      plugins: JSON.stringify(Object.entries(read.config.plugins ?? {})),
      read,
      serverAddress: read.config.temporal?.address ?? address,
    };
  };

  const start = (
    root: string,
    serverAddress: string,
    { plugins, read }: { plugins: string; read: ReadProjectConfig },
  ): Promise<RunningWorker> => {
    const taskQueue = projectTaskQueue(root);
    const worker: Promise<RunningWorker> = (async () => {
      const loaded = await loadConfiguredPlugins(read, root);
      // The resident process has no terminal, so only methods that answer in the Worker answer.
      const registry = createRegistry(undefined, loaded);
      // The key is read first, because a process with a prepared engine does not exit by itself
      // until it reaches the server.
      const encryptionKey = loadEncryptionKey();
      prepareEngine();
      const running = await startProjectWorker({
        address: serverAddress,
        aiRunner: createAiRunner({ cwd: root, plugins: registry }),
        encryptionKey,
        eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
        log: (message) => log(`${root}: ${message}`),
        onError: (error) => {
          // Only the Worker that serves the project now is started again. One on a server that
          // the project named before, and one that stops because the plugins changed, is not,
          // as it is not when the resident process restarts.
          const serves =
            servers.get(root) === serverAddress &&
            workers.get(root)?.get(serverAddress)?.worker === worker;
          forget(root, serverAddress, worker);
          const message = error instanceof Error ? error.message : String(error);
          log(
            serves
              ? `Worker of ${root} failed: ${message}${again(retryLater(root))}`
              : `Worker of ${root} at ${serverAddress} failed: ${message}. It is not started again, because the project does not use it now`,
          );
        },
        plugins: registry,
        readEnvironment: createEnvironmentReader(root),
        scriptRunner: createLocalScriptRunner({ cwd: root }),
        taskQueue,
      });
      log(
        `serving ${root} on ${taskQueue}${serverAddress === address ? "" : ` at ${serverAddress}`}`,
      );
      return running;
    })();
    const byServer = workers.get(root) ?? new Map<string, ServedWorker>();
    byServer.set(serverAddress, { plugins, worker });
    workers.set(root, byServer);
    // A Worker that fails to start is forgotten, so that a later request can try again.
    worker.catch(() => forget(root, serverAddress, worker));
    return worker;
  };

  /**
   * Starts the Worker of a project on the server that it names now, unless one runs there.
   *
   * @returns The address of the server.
   */
  const serve = async (root: string): Promise<string> => {
    const settings = await settingsOf(root);
    const { serverAddress } = settings;
    const previousAddress = servers.get(root);
    servers.set(root, serverAddress);
    if (
      previousAddress !== undefined &&
      previousAddress !== serverAddress &&
      workers.get(root)?.has(previousAddress) === true
    ) {
      log(
        `${root} now uses ${serverAddress}. Its Worker at ${previousAddress} keeps serving the runs there until ugoke daemon stops`,
      );
    }
    const served = workers.get(root)?.get(serverAddress);
    // A Worker that the project used before on the same server is used again, unless the
    // plugins changed. Its registry would not have the extensions of the plugins added since.
    if (served?.plugins === settings.plugins) {
      await served.worker;
      return serverAddress;
    }
    try {
      await start(root, serverAddress, settings);
    } catch (error) {
      // The previous Worker keeps serving the project, and stops with the resident process.
      if (served !== undefined && workers.get(root)?.has(serverAddress) !== true) {
        workers.get(root)?.set(serverAddress, served);
      }
      throw error;
    }
    if (served !== undefined) {
      log(`restarted the Worker of ${root} at ${serverAddress}, because its plugins changed`);
      // Two Workers on the same task queue share its tasks, so the previous one stops after the
      // scripts that it runs finish. It stops only after the new one started, so that the
      // project keeps a Worker when the new one cannot start.
      const stop = served.worker
        .then(async (previous) => previous.stop())
        .catch((error: unknown) => {
          log(
            `previous Worker of ${root} did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      stopping.add(stop);
      void stop.finally(() => stopping.delete(stop));
    }
    return serverAddress;
  };

  /**
   * Starts the Worker of a project again later, unless that is already planned.
   *
   * The resident process tries until the Worker runs, because nothing else would start it: a run
   * that was detached would wait until someone runs a command in the project.
   *
   * @returns The time before the attempt in milliseconds, when this call planned it.
   */
  const retryLater = (root: string): number | undefined => {
    if (stopped || retryTimers.has(root)) {
      return undefined;
    }
    const delayMs = retryDelays.get(root) ?? retryDelayMs.first;
    retryDelays.set(root, Math.min(delayMs * 2, retryDelayMs.longest));
    retryTimers.set(
      root,
      setTimeout(() => {
        retryTimers.delete(root);
        if (stopped) {
          return;
        }
        // A project that was moved or deleted is dropped when the resident process starts.
        if (!isProject(root)) {
          retryDelays.delete(root);
          log(`stopped trying to serve ${root}, because it has no ${ugokeDirectory} directory`);
          return;
        }
        // The failure is logged where it is planned to try again.
        ensure(root).catch(() => {});
      }, delayMs),
    );
    return delayMs;
  };

  /**
   * Serves a project after the requests that came before for the same project.
   *
   * A project that cannot be served is tried again later.
   */
  const ensure = async (root: string): Promise<string> => {
    const request = (pending.get(root) ?? Promise.resolve(""))
      // A failed request does not keep later ones from trying again.
      .catch(() => "")
      .then(async () => serve(root));
    pending.set(root, request);
    try {
      const serverAddress = await request;
      clearTimeout(retryTimers.get(root));
      retryTimers.delete(root);
      retryDelays.delete(root);
      return serverAddress;
    } catch (error) {
      log(
        `cannot serve ${root} yet: ${error instanceof Error ? error.message : String(error)}${again(retryLater(root))}`,
      );
      throw error;
    } finally {
      if (pending.get(root) === request) {
        pending.delete(root);
      }
    }
  };

  return {
    add: async (root) => {
      if (stopped) {
        throw new WorkersStoppedError();
      }
      if (!isProject(root)) {
        throw new Error(`Not a project, because it has no ${ugokeDirectory} directory: ${root}`);
      }
      roots.add(root);
      save();
      const serverAddress = await ensure(root);
      return { address: serverAddress, root, taskQueue: projectTaskQueue(root) };
    },
    list: () =>
      [...roots].map((root) => {
        const serverAddress = servers.get(root);
        const byServer = workers.get(root);
        const previousAddresses = [...(byServer?.keys() ?? [])].filter(
          (served) => served !== serverAddress,
        );
        return {
          ...(serverAddress === undefined ? {} : { address: serverAddress }),
          ...(previousAddresses.length === 0 ? {} : { previousAddresses }),
          root,
          running: serverAddress !== undefined && byServer?.has(serverAddress) === true,
          taskQueue: projectTaskQueue(root),
        };
      }),
    restore: async () => {
      const restored = readRoots(file).filter((root) => {
        // Only a project that was moved or deleted is dropped. A Worker that fails to start,
        // such as when the server cannot be reached, is tried again later.
        if (!isProject(root)) {
          log(`dropped ${root}, because it has no ${ugokeDirectory} directory`);
          return false;
        }
        roots.add(root);
        return true;
      });
      save();
      // The failures are logged where it is planned to try again.
      await Promise.all(restored.map(async (root) => ensure(root).catch(() => {})));
    },
    stopAll: async () => {
      stopped = true;
      for (const timer of retryTimers.values()) {
        clearTimeout(timer);
      }
      retryTimers.clear();
      // A request that is on its way may still start a Worker, which is then stopped below.
      while (pending.size > 0) {
        await Promise.allSettled(pending.values());
      }
      const running = await Promise.allSettled(
        [...workers.values()].flatMap((byServer) =>
          [...byServer.values()].map(({ worker }) => worker),
        ),
      );
      await Promise.all(stopping);
      await Promise.all(
        running.map(async (result) =>
          result.status === "fulfilled" ? result.value.stop() : undefined,
        ),
      );
    },
  };
};
