import { workflowCodeVersion } from "@ugoke/engine";

import type { CommandContext } from "../commands/load.js";
import { loadProjectConfig } from "../config.js";
import { openServer } from "../server.js";
import type { OpenedServer, ServerOptions } from "../server.js";
import { getDaemonStatus, registerProject } from "./client.js";
import type { DaemonProject, DaemonStatus } from "./client.js";
import { daemonPaths } from "./paths.js";

/** Thrown when a command needs the resident process, and it does not run or cannot be reached. */
export class DaemonUnavailableError extends Error {
  /**
   * @param detach Whether the command leaves the run to the resident process, so that no other
   *   server can run it.
   * @param start What to do to have a resident process that runs.
   */
  constructor(reason: string, detach = false, start = 'Run "ugoke daemon start"') {
    super(
      detach
        ? `ugoke daemon ${reason}, and --detach needs it to run the steps. ${start}`
        : `ugoke daemon ${reason}. ${start}, choose a server with --address, or set temporal.address in .ugoke/config.yaml`,
    );
    this.name = "DaemonUnavailableError";
  }
}

/** What to do about a resident process that was asked to stop and still runs steps. */
const startAfterStop = 'Run "ugoke daemon start" after it stopped';

/** Options that tell what the command needs from the resident process. */
export interface DaemonUse {
  /**
   * Whether the command leaves the run to the resident process, such as with `--detach`. Without
   * the resident process, the command then cannot run its own Worker instead.
   */
  detach?: boolean | undefined;
}

/** Says what the command does when the resident process does not run the steps. */
const withoutDaemon = ({ detach = false }: DaemonUse): string =>
  detach ? "so it cannot run a detached run" : "so this command runs its own Worker";

/**
 * Says that the resident process has another version, and what the command does without it.
 *
 * @param pollingTaskQueue Task queue that the resident process still serves for the project, whose
 *   runs go on there.
 */
const otherVersion = (
  status: DaemonStatus,
  version: string,
  use: DaemonUse,
  pollingTaskQueue: string | undefined,
): string => {
  const what =
    pollingTaskQueue === undefined
      ? withoutDaemon(use)
      : `so it goes on with only the runs on its task queue, and ${use.detach === true ? "it cannot run a detached run" : "this command runs its own Worker for other runs"}`;
  return `ugoke daemon: runs ugoke ${status.version}, and this is ugoke ${version}, ${what}. Run "ugoke daemon stop" and start it again to use it\n`;
};

/** The Temporal Server of the resident process, for a command. */
export interface DaemonConnection {
  /** Temporal Server of the resident process. */
  server: OpenedServer;
  /**
   * Project that the resident process serves, or `undefined` when the resident process has
   * another version, so that the command runs its own Worker on the same server.
   */
  project?: DaemonProject | undefined;
  /**
   * Task queue that a resident process of another ugoke version still serves for the project,
   * because it has the same workflow code version. A run on it goes on there.
   */
  pollingTaskQueue?: string | undefined;
}

/**
 * Returns the task queue of a project that a resident process serves at an address, when it has
 * the workflow code version of this ugoke and the Worker of the project runs.
 *
 * Its Worker keeps serving the runs on that queue even when the command does not hand new runs to
 * it, so the command must not run a second Worker for them.
 */
const pollingQueue = (status: DaemonStatus, root: string, address: string): string | undefined => {
  if (status.workflowCodeVersion !== workflowCodeVersion) {
    return undefined;
  }
  const project = status.projects.find(
    (candidate) =>
      candidate.root === root &&
      candidate.running !== false &&
      (candidate.address ?? status.address) === address,
  );
  return project?.taskQueue;
};

/**
 * Asks the resident process of this host to serve a project.
 *
 * A resident process of another version is not asked to serve it, because it could not run
 * definitions or runs of this version. The command then runs its own Worker on the server of the
 * resident process, and says why.
 *
 * @param version Version of this ugoke.
 * @throws {DaemonUnavailableError} When the resident process does not run or cannot be reached.
 */
export const connectDaemon = async (
  root: string,
  version: string,
  context: CommandContext,
  use: DaemonUse = {},
): Promise<DaemonConnection> => {
  const paths = daemonPaths();
  const status = await getDaemonStatus(paths).catch((error: unknown) => {
    throw new DaemonUnavailableError(
      `cannot be reached: ${error instanceof Error ? error.message : String(error)}`,
      use.detach,
    );
  });
  if (status === undefined) {
    throw new DaemonUnavailableError("is not running", use.detach);
  }
  if (status.stopping === true) {
    throw new DaemonUnavailableError("is stopping", use.detach, startAfterStop);
  }
  const server: OpenedServer = {
    address: status.address,
    // Later commands find the resident process again by themselves.
    options: "",
  };
  if (status.version !== version || status.workflowCodeVersion !== workflowCodeVersion) {
    const pollingTaskQueue = pollingQueue(status, root, status.address);
    context.stderr(otherVersion(status, version, use, pollingTaskQueue));
    return { pollingTaskQueue, server };
  }
  return { project: await registerProject(paths, root), server };
};

/** The Temporal Server that a command uses, and the task queue that the resident process serves. */
export interface CommandServer {
  server: OpenedServer;
  /** Task queue that the resident process serves for the project, when it runs the steps. */
  servedTaskQueue?: string | undefined;
  /** See {@link DaemonConnection.pollingTaskQueue}. */
  pollingTaskQueue?: string | undefined;
}

/** Task queues of a project in the resident process, as {@link CommandServer} has them. */
type DaemonQueues = Pick<CommandServer, "pollingTaskQueue" | "servedTaskQueue">;

/**
 * Asks the resident process to serve a project on the server that the project names, when it runs
 * with the same version.
 *
 * The resident process runs the Worker of the project on that server too. The project names its
 * server, so the command runs its own Worker without the resident process. When the resident
 * process runs but is not used, the command says why, because a run then stops with the command.
 *
 * @returns The task queue that it serves, which is missing when the command runs its own Worker.
 */
const daemonOn = async (
  address: string,
  root: string,
  version: string,
  context: CommandContext,
  use: DaemonUse,
): Promise<DaemonQueues> => {
  const paths = daemonPaths();
  let status;
  try {
    status = await getDaemonStatus(paths);
  } catch (error) {
    context.stderr(
      `ugoke daemon: cannot be reached, ${withoutDaemon(use)}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return {};
  }
  if (status === undefined) {
    // A run without the resident process is usual for a project that names its server.
    if (use.detach === true) {
      context.stderr(
        `ugoke daemon: is not running, ${withoutDaemon(use)}. Run "ugoke daemon start"\n`,
      );
    }
    return {};
  }
  if (status.stopping === true) {
    context.stderr(`ugoke daemon: is stopping, ${withoutDaemon(use)}. ${startAfterStop}\n`);
    return {};
  }
  if (status.version !== version || status.workflowCodeVersion !== workflowCodeVersion) {
    const pollingTaskQueue = pollingQueue(status, root, address);
    context.stderr(otherVersion(status, version, use, pollingTaskQueue));
    return { pollingTaskQueue };
  }
  const project = await registerProject(paths, root);
  // The resident process reads the configuration file again, which may have changed since.
  if (project.address !== address) {
    context.stderr(
      `ugoke daemon: serves the project at ${project.address ?? status.address}, and temporal.address of the project is ${address}, ${withoutDaemon(use)}\n`,
    );
    return {};
  }
  return { servedTaskQueue: project.taskQueue };
};

/**
 * Opens the Temporal Server of a command.
 *
 * The options of the command come first. Without them, the server is the one that
 * `temporal.address` in the configuration file of the project names, or that of the resident
 * process.
 *
 * The messages about the resident process say what the command does without it, which depends on
 * whether the command leaves the run to it (`detach`).
 *
 * @param version Version of this ugoke, which the resident process must have to run the steps.
 * @throws {DaemonUnavailableError} When no server is named and the resident process is not
 *   available.
 * @throws {ProjectConfigError} When the configuration file of the project is invalid.
 */
export const openCommandServer = async (
  { detach, server, version }: { server?: ServerOptions | undefined; version: string } & DaemonUse,
  root: string,
  context: CommandContext,
): Promise<CommandServer> => {
  if (server !== undefined) {
    return { server: openServer(server) };
  }
  const address = (await loadProjectConfig(root, context.cwd)).temporal?.address;
  if (address !== undefined) {
    const opened = openServer({ address, type: "address" });
    const queues = await daemonOn(address, root, version, context, { detach });
    return {
      pollingTaskQueue: queues.pollingTaskQueue,
      // Later commands read the configuration file again.
      server: { ...opened, options: "" },
      servedTaskQueue: queues.servedTaskQueue,
    };
  }
  const daemon = await connectDaemon(root, version, context, { detach });
  return {
    pollingTaskQueue: daemon.pollingTaskQueue,
    server: daemon.server,
    servedTaskQueue: daemon.project?.taskQueue,
  };
};
