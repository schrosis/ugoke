import type {
  AiRunner,
  EnvironmentReader,
  EventLog,
  PluginRegistry,
  ScriptRunner,
} from "@ugoke/core";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createActivities } from "./activities/index.js";
import { workerDataConverter } from "./encryption.js";
import { heartbeatOptions, workflowsPath } from "./run.js";

/** Options of {@link startWorker}. */
export interface StartWorkerOptions {
  /** Address of the Temporal Server. */
  address: string;
  /** Temporal namespace. Defaults to `default`. */
  namespace?: string;
  /** Task queue that the Worker serves, such as of a project. */
  taskQueue: string;
  scriptRunner: ScriptRunner;
  aiRunner?: AiRunner | undefined;
  readEnvironment?: EnvironmentReader | undefined;
  /** Encrypts what goes through Temporal. The Worker then refuses values without it. */
  encryptionKey?: Uint8Array | undefined;
  /** Stores the progress events of the runs of the task queue. */
  eventLog: EventLog;
  /** Plugins whose wait methods answer in the Worker, such as from a chat. */
  plugins?: PluginRegistry | undefined;
  /**
   * Writes a line to the log of the Worker, such as of the resident process. Nothing is written
   * when it is omitted.
   */
  log?: ((message: string) => void) | undefined;
  /** Path of the workflow code. Defaults to {@link workflowsPath}. */
  workflowsPath?: string;
  /** Receives a failure of the Worker after it started. */
  onError?: (error: unknown) => void;
}

/** A Worker that runs until it is stopped. */
export interface RunningWorker {
  /**
   * Stops taking tasks, waits for running scripts to finish, and closes the connection.
   *
   * A script that is stopped fails its step, and the run could not be continued.
   */
  stop: () => Promise<void>;
}

/**
 * Starts a Worker that serves a task queue until it is stopped, such as for a resident process.
 *
 * @throws When the Worker cannot start, such as when the server cannot be reached.
 */
export const startWorker = async ({
  address,
  aiRunner,
  encryptionKey,
  eventLog,
  log,
  namespace = "default",
  onError = () => {},
  plugins,
  readEnvironment,
  scriptRunner,
  taskQueue,
  workflowsPath: path = workflowsPath,
}: StartWorkerOptions): Promise<RunningWorker> => {
  const connection = await NativeConnection.connect({ address });
  const stopping = new AbortController();
  try {
    const worker = await Worker.create({
      activities: createActivities({
        aiRunner,
        eventLog,
        log,
        plugins,
        readEnvironment,
        scriptRunner,
        stopping: stopping.signal,
      }),
      ...workerDataConverter(encryptionKey),
      ...heartbeatOptions,
      connection,
      namespace,
      // Stopping waits for running scripts, as when a run detaches.
      shutdownGraceTime: "1 day",
      taskQueue,
      workflowsPath: path,
    });
    const running = worker.run().catch(onError);
    return {
      stop: async () => {
        // Waits end first, because the Worker waits for them as for running scripts.
        stopping.abort();
        if (worker.getState() === "RUNNING") {
          worker.shutdown();
        }
        await running;
        await connection.close();
      },
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
};
