import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { CommandContext } from "../commands/load.js";
import { workflowCodeVersion } from "@ugoke/engine";

import { quote, serverArguments } from "../server.js";
import type { ServerOptions } from "../server.js";
import { getDaemonStatus, requestDaemonStop } from "./client.js";
import type { DaemonStatus } from "./client.js";
import { checkSocketPath, daemonPaths } from "./paths.js";

/** Time to wait for the resident process to start or stop, in milliseconds. */
const waitTimeoutMs = 60_000;

/** Options of {@link startDaemon}. */
export interface StartDaemonOptions {
  /**
   * Temporal Server of the resident process. Without it, the resident process starts a
   * development server, which keeps its runs in the state directory.
   */
  server?: ServerOptions | undefined;
  /** Version of this ugoke, to tell whether a running resident process differs. */
  version: string;
  /** Path of the ugoke executable that runs the resident process. */
  executable: string;
}

/** Returns how a running resident process differs from the one that a command asks for. */
const differences = (running: DaemonStatus, version: string, requested: string[]): string[] => {
  const notes: string[] = [];
  if (running.version !== version || running.workflowCodeVersion !== workflowCodeVersion) {
    notes.push(`it runs ugoke ${running.version}, and this is ugoke ${version}`);
  }
  const runningOptions = running.serverOptions.trim();
  // The running process quotes its options for a command line, so the request is quoted too.
  if (runningOptions !== requested.map(quote).join(" ")) {
    notes.push(
      runningOptions === ""
        ? "it uses its own development server"
        : `it uses the server options "${runningOptions}"`,
    );
  }
  return notes;
};

/** Returns the end of the log, to explain why the resident process did not start. */
const logTail = (file: string): string => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-10).join("\n");
  } catch {
    return "";
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const describe = ({ address, pid, version }: DaemonStatus): string =>
  `pid ${pid}, server ${address}, ugoke ${version}`;

/**
 * Starts the resident process of this host in the background.
 *
 * @returns The exit code of the command.
 */
export const startDaemon = async (
  { executable, server, version }: StartDaemonOptions,
  context: CommandContext,
): Promise<number> => {
  const paths = daemonPaths();
  checkSocketPath(paths.socket);
  const requested = server === undefined ? [] : serverArguments(server);
  const running = await getDaemonStatus(paths);
  if (running !== undefined) {
    context.stdout(`ugoke daemon: already running (${describe(running)})\n`);
    const notes = differences(running, version, requested);
    if (notes.length > 0) {
      context.stderr(
        `ugoke daemon: ${notes.join(", and ")}. Run "ugoke daemon stop" and start it again to change it\n`,
      );
    }
    return 0;
  }

  mkdirSync(paths.directory, { mode: 0o700, recursive: true });
  const logFile = openSync(paths.log, "a", 0o600);
  let exited: number | null | undefined;
  try {
    const child = spawn(
      process.execPath,
      [executable, "daemon", "run", ...requested],
      // The resident process outlives the terminal, so it has its own session and no terminal.
      // It runs in the state directory, so that it does not hold a project directory.
      { cwd: paths.directory, detached: true, stdio: ["ignore", logFile, logFile] },
    );
    child.once("exit", (code) => {
      exited = code;
    });
    child.unref();
  } finally {
    closeSync(logFile);
  }

  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus(paths).catch(() => undefined);
    if (status !== undefined) {
      context.stdout(`ugoke daemon: started (${describe(status)})\n`);
      return 0;
    }
    if (exited !== undefined) {
      const tail = logTail(paths.log);
      context.stderr(`ugoke daemon: failed to start${tail === "" ? "" : `:\n${tail}`}\n`);
      return 1;
    }
    await sleep(100);
  }
  // It may still start, such as after downloading the Temporal CLI on a slow network.
  context.stderr(
    `ugoke daemon: did not answer within ${waitTimeoutMs / 1000} seconds, and may still be starting. Run "ugoke daemon status" later, or see ${paths.log}\n`,
  );
  return 1;
};

/**
 * Stops the resident process of this host, and waits for it to exit.
 *
 * @returns The exit code of the command.
 */
export const stopDaemon = async (context: CommandContext): Promise<number> => {
  const paths = daemonPaths();
  const status = await getDaemonStatus(paths);
  if (status === undefined) {
    context.stdout("ugoke daemon: not running\n");
    return 0;
  }
  await requestDaemonStop(paths);
  const deadline = Date.now() + waitTimeoutMs;
  while (isAlive(status.pid)) {
    if (Date.now() > deadline) {
      context.stderr(
        `ugoke daemon: did not stop within ${waitTimeoutMs / 1000} seconds (pid ${status.pid})\n`,
      );
      return 1;
    }
    await sleep(100);
  }
  context.stdout("ugoke daemon: stopped\n");
  return 0;
};

/**
 * Shows the state of the resident process of this host.
 *
 * @returns The exit code of the command: 0 when it runs, and 1 when it does not.
 */
export const showDaemonStatus = async (context: CommandContext): Promise<number> => {
  const paths = daemonPaths();
  const status = await getDaemonStatus(paths);
  if (status === undefined) {
    context.stdout("ugoke daemon: not running\n");
    return 1;
  }
  context.stdout(
    [
      `ugoke daemon: running (${describe(status)})`,
      `started: ${status.startedAt}`,
      `log: ${paths.log}`,
      ...(status.projects.length === 0
        ? ["projects: none"]
        : [
            "projects:",
            ...status.projects.map(({ address, previousAddresses = [], root, running }) => {
              const notes = [
                ...(address === undefined || address === status.address
                  ? []
                  : [`server ${address}`]),
                ...previousAddresses.map((previous) => `previous server ${previous}`),
                ...(running === false ? ["Worker not running"] : []),
              ];
              return `  ${root}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
            }),
          ]),
      "",
    ].join("\n"),
  );
  return 0;
};
