import { request } from "node:http";

import type { DaemonPaths } from "./paths.js";

/** State of the resident process that `GET /status` returns. */
export interface DaemonStatus {
  pid: number;
  /** Address of the Temporal Server that the resident process uses. */
  address: string;
  /**
   * Options that reach the same Temporal Server again, such as ` --address localhost:7233`. It is
   * empty for the development server of the resident process.
   */
  serverOptions: string;
  /** Version of the ugoke that runs the resident process. */
  version: string;
  /** Workflow code version of the resident process. */
  workflowCodeVersion: number;
  startedAt: string;
  /**
   * Whether it was asked to stop. It then waits for the steps that it runs to finish, and takes no
   * project.
   */
  stopping?: boolean | undefined;
  /** Projects that the resident process serves. */
  projects: DaemonProject[];
}

/** A project that the resident process serves. */
export interface DaemonProject {
  /** Real path of the project root. */
  root: string;
  taskQueue: string;
  /**
   * Address of the Temporal Server that its Worker uses: `temporal.address` in the configuration
   * file of the project, or the server of the resident process.
   */
  address?: string | undefined;
  /**
   * Servers that the project named before, whose Workers keep serving the runs there until the
   * resident process stops.
   */
  previousAddresses?: string[] | undefined;
  /** Whether its Worker runs. A Worker that failed is started again on the next request. */
  running?: boolean;
}

/** Sends a request to the resident process and returns its JSON response. */
const call = async (
  paths: DaemonPaths,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { "content-type": "application/json" };
    const outgoing = request({ headers, method, path, socketPath: paths.socket }, (response) => {
      let received = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        received += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(
            new Error(`ugoke daemon answered ${response.statusCode ?? "nothing"}: ${received}`),
          );
          return;
        }
        try {
          resolve(received === "" ? undefined : JSON.parse(received));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });

const isStatus = (value: unknown): value is DaemonStatus =>
  typeof value === "object" &&
  value !== null &&
  "pid" in value &&
  typeof value.pid === "number" &&
  "address" in value &&
  typeof value.address === "string";

/**
 * Returns the state of the resident process, or `undefined` when it does not run.
 *
 * A socket that no process listens on, such as one that a killed process left, counts as not
 * running.
 */
export const getDaemonStatus = async (paths: DaemonPaths): Promise<DaemonStatus | undefined> => {
  try {
    const status = await call(paths, "GET", "/status");
    if (!isStatus(status)) {
      throw new Error("ugoke daemon answered an unexpected status");
    }
    return status;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      return undefined;
    }
    throw error;
  }
};

const isProject = (value: unknown): value is DaemonProject =>
  typeof value === "object" &&
  value !== null &&
  "root" in value &&
  typeof value.root === "string" &&
  "taskQueue" in value &&
  typeof value.taskQueue === "string";

/**
 * Asks the resident process to serve a project, and returns the task queue of the project.
 *
 * The resident process remembers the project across restarts.
 */
export const registerProject = async (paths: DaemonPaths, root: string): Promise<DaemonProject> => {
  const project = await call(paths, "POST", "/projects", { root });
  if (!isProject(project)) {
    throw new Error("ugoke daemon answered an unexpected project");
  }
  return project;
};

/** Asks the resident process to stop. It answers before it stops. */
export const requestDaemonStop = async (paths: DaemonPaths): Promise<void> => {
  await call(paths, "POST", "/stop");
};
