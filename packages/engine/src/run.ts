import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createPluginRegistry } from "@ugoke/core";
import type {
  AiRunner,
  EnvironmentReader,
  EventLog,
  EventSink,
  Intermediate,
  PluginRegistry,
  ScriptRunner,
  WorkflowEvent,
} from "@ugoke/core";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import type { LogLevel } from "@temporalio/worker";

import { createActivities } from "./activities/index.js";
import { clientDataConverter, listingDataConverter, workerDataConverter } from "./encryption.js";
import { answerWaits } from "./answer.js";
import { createMemoryEventLog, followEvents } from "./events.js";
import {
  IncompatibleRunError,
  isCompatibleMemo,
  workflowCodeVersion,
  workflowCodeVersionMemoKey,
} from "./version.js";
import type { EventFollower } from "./events.js";
import type { ugoke } from "./workflows/index.js";

const discardEvents: EventSink = { emit: () => {} };

/**
 * Worker options that let a cancellation reach a running step soon.
 *
 * Temporal tells an activity that it is cancelled in the answer to a heartbeat. A Worker holds
 * heartbeats back for most of the heartbeat timeout by default, which would keep a cancelled
 * script or AI running for tens of seconds. With this limit, each heartbeat of an activity is
 * sent, so the cancellation arrives within the interval of the heartbeats.
 */
export const heartbeatOptions = { maxHeartbeatThrottleInterval: "1 second" } as const;

/** Path of the built workflow code that a Worker bundles. */
export const workflowsPath = fileURLToPath(new URL("./workflows.js", import.meta.url));

/** Options of {@link configureRuntime}. */
export interface RuntimeOptions {
  /** Minimum level of the logs that Temporal Workers write. */
  logLevel: LogLevel;
}

/**
 * Configures the Temporal runtime for an application that handles process signals itself.
 *
 * By default, the Temporal runtime shuts down Workers on SIGINT and SIGTERM, which would stop
 * a run before its cancellation completes. This disables that behavior, so pass an
 * `AbortSignal` to {@link runWorkflow} to cancel runs instead.
 *
 * Call it once, before {@link runWorkflow}, because the Temporal runtime is configured only once.
 */
export const configureRuntime = ({ logLevel }: RuntimeOptions): void => {
  Runtime.install({
    logger: new DefaultLogger(logLevel),
    shutdownSignals: [],
    // Native logs are forwarded to the logger so that the same level applies to them.
    telemetryOptions: { logging: { filter: { core: logLevel, other: logLevel }, forward: {} } },
  });
};

/** How a run ended for the process that followed it. */
export type RunOutcome =
  | { status: "completed"; workflowId: string; executedSteps: string[] }
  /** The process stopped following, and the run waits in Temporal until a process attaches to it. */
  | { status: "detached"; workflowId: string };

/** Options of {@link runWorkflow} and {@link attachWorkflow}. */
export interface FollowOptions {
  /** Address of the Temporal Server, such as `localhost:7233`. */
  address: string;
  /** Temporal namespace. Defaults to `default`. */
  namespace?: string;
  scriptRunner: ScriptRunner;
  aiRunner?: AiRunner | undefined;
  readEnvironment?: EnvironmentReader | undefined;
  /** Encrypts what goes through Temporal. A Worker then refuses values without it. */
  encryptionKey?: Uint8Array | undefined;
  /** Receives progress events of the run, in order. */
  eventSink?: EventSink;
  /**
   * Stores the progress events, so that the Worker and the process that shows the run can be
   * different. Defaults to a log in memory.
   */
  eventLog?: EventLog;
  /** Path of the workflow code. Defaults to {@link workflowsPath}. */
  workflowsPath?: string;
  /** Cancels the workflow, including its running script, when aborted. */
  signal?: AbortSignal;
  /**
   * Stops following the run when aborted, and leaves the workflow running in Temporal.
   *
   * The Worker of this process stops taking new tasks, and waits for a running script to
   * finish, so that the run can go on when a process attaches to it.
   */
  detach?: AbortSignal;
  /**
   * Plugins whose wait methods answer the wait steps of the run: in this process, and in the
   * Worker of this process for methods that answer in the Worker.
   */
  plugins?: PluginRegistry;
  /**
   * Whether this process runs a Worker for the run. Without one, another Worker, such as of a
   * resident process, runs the steps, and this process only shows the run and answers it.
   */
  startWorker?: boolean;
  /**
   * Receives a problem that does not stop the run, such as a progress log that cannot be read.
   * Each kind of problem is reported once per run.
   */
  onWarning?: (message: string) => void;
  /**
   * Called with the run once a Worker can serve it, before this process follows it, such as to
   * answer the step that it waits at. The run is not followed when it throws.
   */
  beforeFollow?: (handle: WorkflowHandle) => Promise<void>;
  /**
   * Shows only the events that the run stores from now on. By default, a run that a process attaches
   * to shows its earlier events first.
   */
  skipEarlierEvents?: boolean;
}

/** Options of {@link runWorkflow}. */
export interface RunWorkflowOptions extends FollowOptions {
  /**
   * Name of the workflow, such as `deploy` or `release/notes`.
   *
   * It prefixes the workflow ID so that runs are easy to find in the Temporal Web UI.
   */
  name: string;
  intermediate: Intermediate;
  /** Values of the workflow input, keyed by name. The workflow validates them. */
  inputs?: Readonly<Record<string, unknown>>;
  /** Values that mark the run, such as its project, for {@link listRunningWorkflows}. */
  memo?: Readonly<Record<string, string>>;
  /** Called with the workflow ID as soon as the workflow starts. */
  onStart?: (workflowId: string) => void;
  /**
   * Task queue of the run, such as of a project that a resident process serves. Defaults to a
   * task queue for this run only.
   */
  taskQueue?: string;
}

/** Options of {@link attachWorkflow}. */
export interface AttachWorkflowOptions extends FollowOptions {
  /** ID of a running workflow. */
  workflowId: string;
  /** Cancels the workflow as soon as it attaches to it, such as for `ugoke cancel`. */
  cancel?: boolean;
  /** Attaches to a run that workflow code of another version started, which can fail. */
  force?: boolean;
  /**
   * Task queue that another Worker serves, such as of a resident process. A run on it is followed
   * without a Worker of this process, unless `startWorker` says otherwise.
   */
  servedTaskQueue?: string | undefined;
}

/**
 * Time that a detaching Worker waits for a running script to finish.
 *
 * A script that is stopped fails its step, and the run could not be continued.
 */
const detachGraceTime = "1 day";

const withConnections = async <T>(
  address: string,
  use: (client: Connection, worker: NativeConnection) => Promise<T>,
): Promise<T> => {
  const workerConnection = await NativeConnection.connect({ address });
  try {
    const clientConnection = await Connection.connect({ address });
    try {
      return await use(clientConnection, workerConnection);
    } finally {
      await clientConnection.close();
    }
  } finally {
    await workerConnection.close();
  }
};

/**
 * Runs a Worker for a task queue and follows a run until it ends or the process detaches.
 *
 * @param open Starts or finds the workflow, after the Worker is ready.
 */
const follow = async (
  options: FollowOptions & { taskQueue: string; cancelNow?: boolean },
  connections: { client: Client; connection: Connection; worker: NativeConnection },
  open: () => Promise<WorkflowHandle<typeof ugoke>>,
): Promise<RunOutcome> => {
  const {
    aiRunner,
    beforeFollow,
    cancelNow = false,
    skipEarlierEvents = false,
    encryptionKey,
    detach,
    eventLog = createMemoryEventLog(),
    eventSink = discardEvents,
    namespace = "default",
    onWarning = () => {},
    plugins = createPluginRegistry(),
    readEnvironment,
    scriptRunner,
    signal,
    startWorker = true,
    taskQueue,
    workflowsPath: path = workflowsPath,
  } = options;
  // Waits of the Worker end before it stops, because it waits for them as for running scripts.
  const stopping = new AbortController();
  const worker = startWorker
    ? await Worker.create({
        activities: createActivities({
          aiRunner,
          eventLog,
          plugins,
          readEnvironment,
          scriptRunner,
          stopping: stopping.signal,
        }),
        ...workerDataConverter(encryptionKey),
        ...heartbeatOptions,
        connection: connections.worker,
        namespace,
        shutdownGraceTime: detachGraceTime,
        taskQueue,
        workflowsPath: path,
      })
    : undefined;

  let handle: WorkflowHandle<typeof ugoke> | undefined;
  let follower: EventFollower | undefined;
  let outcome: RunOutcome;
  try {
    const followRun = async (): Promise<RunOutcome> => {
      handle = await open();
      const { workflowId } = handle;
      const current = handle;
      // The position is read before the answer of beforeFollow, so that its events are shown.
      const cursor = skipEarlierEvents ? (await eventLog.read(workflowId)).cursor : undefined;
      await beforeFollow?.(current);
      // The method that asks a step hears of its end before it is shown, so that the notice that
      // another process answered it comes first.
      const finishedListeners = new Set<
        (event: Extract<WorkflowEvent, { type: "stepFinished" }>) => void
      >();
      const shownSink: EventSink = {
        emit: (event) => {
          if (event.type === "stepFinished") {
            for (const listener of finishedListeners) {
              listener(event);
            }
          }
          eventSink.emit(event);
        },
      };
      // A log that cannot be read would hide every later event, so it is reported once.
      let warned = false;
      follower = followEvents({
        cursor,
        log: eventLog,
        onError: (error) => {
          if (!warned) {
            warned = true;
            onWarning(
              `Failed to show the progress of the run: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        runId: workflowId,
        sink: shownSink,
      });
      const visible = follower;
      const cancel = (): void => {
        // The result below reports the cancellation, so a failed request is not rethrown.
        current.cancel().catch(() => {});
      };
      if (signal?.aborted === true || cancelNow) {
        cancel();
      }
      signal?.addEventListener("abort", cancel, { once: true });
      // Stops answering when the run ends, is interrupted, or detaches.
      const answering = new AbortController();
      const stopAnswering = (): void => answering.abort();
      signal?.addEventListener("abort", stopAnswering, { once: true });
      detach?.addEventListener("abort", stopAnswering, { once: true });
      // A wait step that cannot be answered would wait forever, so the run is cancelled and
      // reports why it could not be answered.
      let answerFailure: { error: unknown } | undefined;
      // A run that is cancelled right away is not answered.
      const answeringTask = cancelNow
        ? Promise.resolve()
        : answerWaits({
            flush: visible.flush,
            handle: current,
            notify: (event) => eventSink.emit(event),
            onStepFinished: (listener) => {
              finishedListeners.add(listener);
              return () => finishedListeners.delete(listener);
            },
            plugins,
            report: async (event) => {
              eventLog.append(workflowId, event);
              await visible.flush();
            },
            signal: answering.signal,
          });
      const answered = answeringTask.catch((error: unknown) => {
        // An interrupt also stops answering, and the result reports the cancellation.
        if (!answering.signal.aborted) {
          answerFailure = { error };
          cancel();
        }
      });
      const detached = new Promise<RunOutcome>((resolve) => {
        const onDetach = (): void => resolve({ status: "detached", workflowId });
        if (detach?.aborted === true) {
          onDetach();
        }
        detach?.addEventListener("abort", onDetach, { once: true });
      });
      // Waiting for the result is a long call, which is aborted when the run detaches. A call
      // that is left running would retry on a closed connection and crash the process.
      const waitingForResult = new AbortController();
      const result = connections.connection.withAbortSignal(waitingForResult.signal, async () =>
        current.result(),
      );
      try {
        return await Promise.race([
          result.then((value): RunOutcome => ({ ...value, status: "completed", workflowId })),
          detached,
        ]);
      } catch (error) {
        throw answerFailure === undefined ? error : answerFailure.error;
      } finally {
        waitingForResult.abort();
        // The result of a detached run is not needed.
        result.catch(() => {});
        // The end of a step that another process answered comes before the end of the run, so it
        // is shown while the method still asks, which then shows the notice first.
        await visible.flush();
        answering.abort();
        await answered;
        signal?.removeEventListener("abort", cancel);
        signal?.removeEventListener("abort", stopAnswering);
        detach?.removeEventListener("abort", stopAnswering);
      }
    };
    // The Worker of this process stops after the run ends or detaches.
    outcome = await (worker === undefined
      ? followRun()
      : worker.runUntil(async () => followRun().finally(() => stopping.abort())));
  } finally {
    // The Worker has stopped, after the running script finished. Its events are shown before
    // the outcome, also when the run failed.
    await follower?.stop();
  }

  // The run may have ended while the Worker waited for the last script. A run that has ended
  // is reported like any other end, and the result throws when it failed.
  if (outcome.status === "detached" && handle !== undefined) {
    const { status } = await handle.describe();
    if (status.name !== "RUNNING") {
      return { ...(await handle.result()), status: "completed", workflowId: outcome.workflowId };
    }
  }
  return outcome;
};

/** What {@link startRun} needs to start a run. */
type StartRunOptions = Pick<RunWorkflowOptions, "inputs" | "intermediate" | "memo" | "name"> & {
  taskQueue: string;
  id: string;
};

/** Starts the interpreter workflow for a run, recording the workflow code version. */
const startRun = async (
  client: Client,
  { id, inputs = {}, intermediate, memo, name, taskQueue }: StartRunOptions,
): Promise<WorkflowHandle<typeof ugoke>> =>
  client.workflow.start<typeof ugoke>("ugoke", {
    args: [intermediate, inputs],
    // The version lets a later process tell whether it can continue the run.
    memo: { ...memo, [workflowCodeVersionMemoKey]: String(workflowCodeVersion) },
    taskQueue,
    workflowId: `${name}-${id}`,
  });

/**
 * Starts a workflow and follows it with a Worker that lives only for this run.
 *
 * @throws When the workflow fails, for example because a script step fails.
 */
export const runWorkflow = async (options: RunWorkflowOptions): Promise<RunOutcome> => {
  const { address, namespace = "default", onStart = () => {} } = options;
  const id = randomUUID();
  // A task queue for this run keeps other Workers from picking up its tasks.
  const taskQueue = options.taskQueue ?? `ugoke-${id}`;
  return withConnections(address, async (clientConnection, workerConnection) => {
    const client = new Client({
      connection: clientConnection,
      namespace,
      ...clientDataConverter(options.encryptionKey),
    });
    return follow(
      { ...options, taskQueue },
      { client, connection: clientConnection, worker: workerConnection },
      async () => {
        const handle = await startRun(client, { ...options, id, taskQueue });
        onStart(handle.workflowId);
        return handle;
      },
    );
  });
};

/** Options of {@link startWorkflow}. */
export interface StartWorkflowOptions extends Pick<
  RunWorkflowOptions,
  "address" | "encryptionKey" | "inputs" | "intermediate" | "memo" | "name" | "namespace"
> {
  /** Task queue that another Worker serves, such as of a resident process. */
  taskQueue: string;
}

/**
 * Starts a workflow without following it, for a Worker of another process to run it.
 *
 * @returns The workflow ID of the run.
 */
export const startWorkflow = async (options: StartWorkflowOptions): Promise<string> => {
  const { address, encryptionKey, namespace = "default", taskQueue } = options;
  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace, ...clientDataConverter(encryptionKey) });
    const handle = await startRun(client, { ...options, id: randomUUID(), taskQueue });
    return handle.workflowId;
  } finally {
    await connection.close();
  }
};

/**
 * Attaches to a running workflow and follows it with a Worker on its task queue, such as after
 * the process that started it exited.
 *
 * @throws When the workflow is not running, or when it fails.
 */
export const attachWorkflow = async (options: AttachWorkflowOptions): Promise<RunOutcome> => {
  const { address, cancel = false, force = false, namespace = "default", workflowId } = options;
  return withConnections(address, async (clientConnection, workerConnection) => {
    const client = new Client({
      connection: clientConnection,
      namespace,
      ...clientDataConverter(options.encryptionKey),
    });
    const handle = client.workflow.getHandle<typeof ugoke>(workflowId);
    const { memo, status, taskQueue } = await handle.describe();
    if (status.name !== "RUNNING") {
      throw new Error(`Workflow ${workflowId} is not running: ${status.name.toLowerCase()}`);
    }
    if (!force && !isCompatibleMemo(memo)) {
      const version = memo?.[workflowCodeVersionMemoKey];
      throw new IncompatibleRunError(workflowId, typeof version === "string" ? version : undefined);
    }
    return follow(
      {
        ...options,
        cancelNow: cancel,
        startWorker: options.startWorker ?? taskQueue !== options.servedTaskQueue,
        taskQueue,
      },
      { client, connection: clientConnection, worker: workerConnection },
      async () => handle,
    );
  });
};

/** Options of {@link terminateWorkflow}. */
export interface TerminateWorkflowOptions {
  address: string;
  namespace?: string;
  workflowId: string;
  /** Why the run is terminated, which Temporal records. */
  reason: string;
}

/**
 * Terminates a running workflow without running its code, such as a run that workflow code of
 * another version started, which could not be cancelled.
 */
export const terminateWorkflow = async ({
  address,
  namespace = "default",
  reason,
  workflowId,
}: TerminateWorkflowOptions): Promise<void> => {
  const connection = await Connection.connect({ address });
  try {
    await new Client({ connection, namespace }).workflow.getHandle(workflowId).terminate(reason);
  } finally {
    await connection.close();
  }
};

/** Options of {@link watchWorkflowStatus}. */
export interface WatchWorkflowStatusOptions {
  address: string;
  namespace?: string;
  workflowId: string;
  /** Key that decrypts the memo of the run, which the description reads. */
  encryptionKey?: Uint8Array | undefined;
}

/** Tells whether a run still runs, over one connection to the Temporal Server. */
export interface WorkflowStatusWatcher {
  /** Returns whether the run still runs. It returns `false` also when the run does not exist. */
  running: () => Promise<boolean>;
  /** Closes the connection. */
  close: () => Promise<void>;
}

/**
 * Connects to the Temporal Server to tell whether a run still runs, such as to stop following
 * its progress after it ends. The connection is kept until it is closed, because a run is
 * asked about again and again.
 */
export const watchWorkflowStatus = async ({
  address,
  encryptionKey,
  namespace = "default",
  workflowId,
}: WatchWorkflowStatusOptions): Promise<WorkflowStatusWatcher> => {
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace, ...listingDataConverter(encryptionKey) });
  const handle = client.workflow.getHandle(workflowId);
  return {
    close: async () => connection.close(),
    running: async () => {
      try {
        const { status } = await handle.describe();
        return status.name === "RUNNING";
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) {
          return false;
        }
        throw error;
      }
    },
  };
};

/** A running workflow that {@link listRunningWorkflows} returns. */
export interface RunningWorkflow {
  workflowId: string;
  startTime: Date;
  /** Task queue of the run, which tells which Worker can continue it. */
  taskQueue: string;
  /** Values that mark the run, from `memo` of {@link runWorkflow}. */
  memo: Readonly<Record<string, unknown>>;
}

/** Options of {@link listRunningWorkflows}. */
export interface ListRunningWorkflowsOptions {
  address: string;
  namespace?: string;
  /** Returns only the runs whose memo has these values, such as the runs of a project. */
  memo?: Readonly<Record<string, string>>;
  /** Key that decrypts the memos of the runs. */
  encryptionKey?: Uint8Array | undefined;
}

/** Lists the running workflows of ugoke, most recent first. */
export const listRunningWorkflows = async ({
  address,
  encryptionKey,
  memo = {},
  namespace = "default",
}: ListRunningWorkflowsOptions): Promise<RunningWorkflow[]> => {
  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace, ...listingDataConverter(encryptionKey) });
    const runs: RunningWorkflow[] = [];
    for await (const info of client.workflow.list({
      query: "WorkflowType = 'ugoke' AND ExecutionStatus = 'Running'",
    })) {
      const values = info.memo ?? {};
      if (Object.entries(memo).every(([key, value]) => values[key] === value)) {
        runs.push({
          memo: values,
          startTime: info.startTime,
          taskQueue: info.taskQueue,
          workflowId: info.workflowId,
        });
      }
    }
    return runs.toSorted((a, b) => b.startTime.getTime() - a.startTime.getTime());
  } finally {
    await connection.close();
  }
};
