import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { workflowCodeVersion } from "@ugoke/engine";

import type { CommandContext } from "../commands/load.js";
import { acquireRunLock, RunLockedError } from "../lock.js";
import { openServer } from "../server.js";
import type { ServerOptions } from "../server.js";
import { ensureTemporalCli, startDevServer } from "../temporal-cli/index.js";
import { getDaemonStatus } from "./client.js";
import type { DaemonStatus } from "./client.js";
import { checkSocketPath, daemonPaths } from "./paths.js";
import { createProjectWorkers } from "./workers.js";
import type { ProjectWorkers } from "./workers.js";

/** Options of {@link runDaemon}. */
export interface RunDaemonOptions {
  /**
   * Temporal Server that the resident process uses. Without it, the resident process starts a
   * development server, which keeps its runs in the state directory.
   */
  server?: ServerOptions | undefined;
  /** Version of the ugoke that runs the resident process. */
  version: string;
  /** Stops the resident process when aborted, such as on SIGTERM. */
  signal: AbortSignal;
  /** Prepares the workflow engine before the Workers start. */
  prepareEngine: () => void;
}

/** Largest body of a request to the resident process, in bytes. */
const maxBodyBytes = 64 * 1024;

/** Reads the JSON body of a request. */
const readJson = async (incoming: IncomingMessage): Promise<unknown> => {
  let body = "";
  incoming.setEncoding("utf8");
  for await (const chunk of incoming) {
    body += String(chunk);
    if (body.length > maxBodyBytes) {
      throw new Error("The request is too large");
    }
  }
  return JSON.parse(body);
};

const respond = (response: ServerResponse, code: number, body: unknown): void => {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
};

/** Returns whether a process runs a Temporal development server, by its command line. */
const isDevServer = (pid: number): boolean => {
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return command.includes("server start-dev");
  } catch {
    // ps fails when no process has the ID.
    return false;
  }
};

/**
 * Stops the development server that a killed resident process left, if it still runs.
 *
 * The command line is checked, so that a process that reused the ID is not stopped.
 */
const stopLeftoverDevServer = async (file: string, context: CommandContext): Promise<void> => {
  let pid: number;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return;
  }
  if (Number.isInteger(pid) && pid > 0 && isDevServer(pid)) {
    log(
      context,
      `ugoke daemon: stopping the development server that was left running (pid ${pid})`,
    );
    try {
      process.kill(-pid, "SIGTERM");
      for (let attempt = 0; attempt < 50 && isDevServer(pid); attempt += 1) {
        await sleep(100);
      }
      if (isDevServer(pid)) {
        process.kill(-pid, "SIGKILL");
      }
    } catch {
      // The server stopped in the meantime.
    }
  }
  rmSync(file, { force: true });
};

const log = (context: CommandContext, message: string): void => {
  context.stderr(`${new Date().toISOString()} ${message}\n`);
};

/** The Temporal Server that the resident process uses. */
interface ResidentServer {
  address: string;
  /** Options that reach the same server again, which `ugoke daemon start` compares. */
  options: string;
  /** Process ID of the development server that the resident process started, if any. */
  pid?: number;
  /** Stops the server when the resident process started it. */
  stop: () => Promise<void>;
}

/**
 * Lets only the owner read the SQLite file of the development server, which holds the history of
 * its runs.
 *
 * The file cannot be created in advance, because the server creates its tables only in a new
 * file.
 */
const protectDb = (dbFilename: string): void => {
  if (existsSync(dbFilename)) {
    chmodSync(dbFilename, 0o600);
  }
};

/**
 * Connects to the Temporal Server of the options, or starts a development server that keeps its
 * runs in a SQLite file.
 *
 * @throws When the development server cannot start, or when the signal is aborted first.
 */
const openResidentServer = async (
  server: ServerOptions | undefined,
  dbFilename: string,
  context: CommandContext,
  signal: AbortSignal,
): Promise<ResidentServer> => {
  if (server !== undefined) {
    return { ...openServer(server), stop: async () => {} };
  }
  const executable = await ensureTemporalCli({
    onDownload: (version) => log(context, `ugoke daemon: downloading Temporal CLI ${version}`),
    signal,
  });
  protectDb(dbFilename);
  const devServer = await startDevServer({ dbFilename, executable, signal });
  // The server creates a new file with the default permissions.
  protectDb(dbFilename);
  return { address: devServer.address, options: "", pid: devServer.pid, stop: devServer.stop };
};

/**
 * Runs the resident process of this host in the foreground until it is stopped.
 *
 * `ugoke daemon start` runs it in the background, with its output in the log file.
 *
 * @returns The exit code of the command.
 */
export const runDaemon = async (
  { prepareEngine, server, signal, version }: RunDaemonOptions,
  context: CommandContext,
): Promise<number> => {
  const paths = daemonPaths();
  checkSocketPath(paths.socket);
  mkdirSync(paths.directory, { mode: 0o700, recursive: true });

  let lock;
  try {
    lock = acquireRunLock(paths.directory, "daemon");
  } catch (error) {
    if (error instanceof RunLockedError) {
      log(context, `ugoke daemon: already running (pid ${error.pid ?? "unknown"})`);
      return 1;
    }
    throw error;
  }

  let opened: ResidentServer | undefined;
  let workers: ProjectWorkers | undefined;
  const http = createServer();
  // It answers until it has stopped, so that commands can tell that it stops from that it does
  // not run.
  const stopping = new AbortController();
  try {
    // A socket that a stopped process left behind would keep the server from listening.
    if ((await getDaemonStatus(paths)) === undefined) {
      rmSync(paths.socket, { force: true });
    }
    // A resident process that was killed could not stop its development server, which would
    // share the SQLite file with the new one.
    await stopLeftoverDevServer(paths.devServer, context);
    opened = await openResidentServer(server, paths.devDb, context, signal);
    if (opened.pid !== undefined) {
      writeFileSync(paths.devServer, `${opened.pid}\n`, { mode: 0o600 });
    }

    signal.addEventListener("abort", () => stopping.abort(), { once: true });
    const address = opened.address;
    workers = createProjectWorkers({
      address,
      file: paths.projects,
      log: (message) => log(context, `ugoke daemon: ${message}`),
      prepareEngine,
    });
    const projects = workers;
    // Projects that the resident process served before it stopped keep their runs going.
    await projects.restore();
    const startedAt = new Date().toISOString();
    const status = (): DaemonStatus => ({
      address,
      pid: process.pid,
      projects: projects.list(),
      serverOptions: opened?.options ?? "",
      startedAt,
      ...(stopping.signal.aborted ? { stopping: true } : {}),
      version,
      workflowCodeVersion,
    });
    http.on("request", (incoming: IncomingMessage, response: ServerResponse) => {
      if (incoming.method === "GET" && incoming.url === "/status") {
        respond(response, 200, status());
      } else if (incoming.method === "POST" && incoming.url === "/stop") {
        respond(response, 200, undefined);
        stopping.abort();
      } else if (incoming.method === "POST" && incoming.url === "/projects") {
        if (stopping.signal.aborted) {
          respond(response, 503, { error: "ugoke daemon is stopping" });
          return;
        }
        void readJson(incoming)
          .then(async (body) => {
            const root =
              typeof body === "object" && body !== null && "root" in body ? body.root : undefined;
            if (typeof root !== "string" || !isAbsolute(root)) {
              respond(response, 400, { error: "root must be an absolute path" });
              return;
            }
            respond(response, 200, await projects.add(await realpath(root)));
          })
          .catch((error: unknown) => {
            respond(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } else {
        respond(response, 404, { error: "Not found" });
      }
    });
    // Only the user can connect to the socket, because its directory is 700.
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(paths.socket, () => {
        http.off("error", reject);
        resolve();
      });
    });
    log(context, `ugoke daemon: started (pid ${process.pid}), server ${opened.address}`);

    if (!stopping.signal.aborted) {
      await new Promise<void>((resolve) => {
        stopping.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    log(context, "ugoke daemon: stopping");
    return 0;
  } catch (error) {
    log(context, `ugoke daemon: failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    stopping.abort();
    // The Workers stop after the scripts that they run finish, so that the runs can continue.
    // That can take long, and the socket stays until then.
    await workers?.stopAll();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    rmSync(paths.socket, { force: true });
    await opened?.stop();
    rmSync(paths.devServer, { force: true });
    lock.release();
    log(context, "ugoke daemon: stopped");
  }
};
