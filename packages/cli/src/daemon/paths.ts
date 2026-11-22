import { join } from "node:path";

import { stateDirectory } from "../state.js";

/**
 * Longest path of a Unix socket that every supported platform accepts, in bytes.
 *
 * macOS allows 104 bytes including the terminating null byte.
 */
const maxSocketPathBytes = 103;

/** Files of the resident process of this host. */
export interface DaemonPaths {
  directory: string;
  /** Unix socket that the CLI talks to the resident process through. */
  socket: string;
  /** Lock that keeps one resident process on the host, holding its process ID. */
  lock: string;
  /** Log of the resident process, including the output of the scripts that it runs. */
  log: string;
  /** File that holds the process ID of the development server that the resident process runs. */
  devServer: string;
  /** SQLite file that keeps the runs of the development server of the resident process. */
  devDb: string;
  /** Projects that the resident process serves, kept across restarts. */
  projects: string;
}

/** Returns the files of the resident process, in the state directory of ugoke. */
export const daemonPaths = (): DaemonPaths => {
  const state = stateDirectory();
  const directory = join(state, "daemon");
  return {
    directory,
    // The file is outside the directory of the resident process, where earlier versions kept it.
    devDb: join(state, "temporal.db"),
    devServer: join(directory, "dev-server.pid"),
    log: join(directory, "daemon.log"),
    projects: join(directory, "projects.json"),
    // acquireRunLock names the lock of "daemon" this way.
    lock: join(directory, "daemon.lock"),
    socket: join(directory, "daemon.sock"),
  };
};

/**
 * Checks that a socket path is short enough for the platform.
 *
 * @throws When the path is too long, such as for a deep XDG_STATE_HOME.
 */
export const checkSocketPath = (socket: string): void => {
  if (Buffer.byteLength(socket) > maxSocketPathBytes) {
    throw new Error(
      `The socket path of ugoke daemon is too long (${Buffer.byteLength(socket)} bytes, at most ${maxSocketPathBytes}): ${socket}. Set XDG_STATE_HOME to a shorter directory`,
    );
  }
};
