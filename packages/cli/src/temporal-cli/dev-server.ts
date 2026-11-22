import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** Options of {@link startDevServer}. */
export interface DevServerOptions {
  /** Path of the Temporal CLI executable. */
  executable: string;
  /** SQLite file that keeps the server state, so that its runs outlive the server. */
  dbFilename: string;
  /** Time to wait for the server to accept connections, in milliseconds. */
  startTimeoutMs?: number;
  /** Time to wait for the server to stop after SIGTERM before it is killed, in milliseconds. */
  stopGraceMs?: number;
  /** Stops waiting for the server to start, and stops the server, when aborted. */
  signal?: AbortSignal | undefined;
}

/** A running Temporal development server. */
export interface DevServer {
  /** Address of the frontend service, such as `127.0.0.1:7233`. */
  address: string;
  /** Process ID of the server, which also leads its process group. */
  pid: number;
  /** Stops the server and waits for it to exit. */
  stop: () => Promise<void>;
}

const host = "127.0.0.1";

/**
 * Host that the HTTP API accepts, which no browser can send.
 *
 * ugoke talks to the server through gRPC only. The HTTP API accepts any content type and does not
 * check the origin, so a web page could start a run through it. Accepting only a reserved name
 * that never resolves turns it off, including against DNS rebinding.
 */
const httpAllowedHost = "ugoke.invalid";

/** Size of the server log that is kept to explain a failed start, in characters. */
const maxLogLength = 4096;

/** Returns a TCP port that is free at the moment. */
const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (address === null || typeof address === "string") {
    throw new Error("Failed to find a free port");
  }
  return address.port;
};

const canConnect = async (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });

/**
 * Returns the arguments of `temporal server start-dev`.
 *
 * Every port is given, so that the server does not take a default port that another server uses.
 * The Web UI is not started, because a web page that the user opens could reach it through DNS
 * rebinding and start a run, which runs commands on this machine.
 */
export const devServerArguments = ({
  dbFilename,
  httpPort,
  port,
}: {
  dbFilename: string;
  httpPort: number;
  port: number;
}): string[] => [
  "server",
  "start-dev",
  "--ip",
  host,
  "--port",
  String(port),
  "--http-port",
  String(httpPort),
  "--dynamic-config-value",
  `frontend.httpAllowedHosts=${JSON.stringify([httpAllowedHost])}`,
  "--headless",
  "--log-level",
  "error",
  "--db-filename",
  dbFilename,
];

/** A server process that exited before it accepted connections, such as for a taken port. */
class ExitedBeforeStartError extends Error {}

const startOnce = async ({
  dbFilename,
  executable,
  signal,
  startTimeoutMs = 30_000,
  stopGraceMs = 5000,
}: DevServerOptions): Promise<DevServer> => {
  const [port, httpPort] = await Promise.all([freePort(), freePort()]);
  const args = devServerArguments({ dbFilename, httpPort, port });
  const child = spawn(executable, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let log = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    log = (log + text).slice(-maxLogLength);
  });

  const kill = (signalName: NodeJS.Signals): void => {
    if (exited || child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, signalName);
    } catch (error) {
      // macOS reports EPERM instead of ESRCH for a process group that has exited.
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ESRCH" && code !== "EPERM") {
        throw error;
      }
    }
  };

  // The server is in another process group, so it would outlive ugoke if ugoke exited without
  // stopping it, such as on an uncaught error.
  const killOnExit = (): void => kill("SIGKILL");
  process.once("exit", killOnExit);

  let exited = false;
  // A process that fails to spawn emits "error" and may not emit "exit".
  const exit = new Promise<void>((resolve) => {
    const settle = (): void => {
      exited = true;
      process.off("exit", killOnExit);
      resolve();
    };
    child.once("exit", settle);
    child.once("error", settle);
  });
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error(`Failed to start the Temporal CLI at ${executable}: ${error.message}`));
    });
  });
  // The error is reported by the start below, so it must not become an unhandled rejection.
  spawnError.catch(() => {});

  const stop = async (): Promise<void> => {
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), stopGraceMs);
    await exit;
    clearTimeout(timer);
  };

  const withLog = (message: string): string => {
    const details = log.trim();
    return details === "" ? message : `${message}:\n${details}`;
  };

  const ready = async (): Promise<void> => {
    const deadline = performance.now() + startTimeoutMs;
    while (!(await canConnect(port))) {
      signal?.throwIfAborted();
      if (exited) {
        throw new ExitedBeforeStartError(
          withLog(`Temporal dev server exited with code ${child.exitCode ?? "unknown"}`),
        );
      }
      if (performance.now() > deadline) {
        throw new Error(withLog(`Temporal dev server did not start within ${startTimeoutMs} ms`));
      }
      await sleep(100);
    }
  };

  try {
    await Promise.race([ready(), spawnError]);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    address: `${host}:${port}`,
    // The server accepts connections, so it has started and has a process ID.
    pid: child.pid ?? 0,
    stop,
  };
};

/**
 * Starts `temporal server start-dev` on free local ports and waits until it accepts connections.
 *
 * The server leads its own process group, which {@link DevServer.stop} signals. An interrupt in
 * a terminal, such as of `ugoke daemon run`, then reaches only ugoke, which stops its Workers
 * before it stops the server.
 */
export const startDevServer = async (options: DevServerOptions): Promise<DevServer> => {
  try {
    return await startOnce(options);
  } catch (error) {
    // Another process can take a free port before the server binds it, so retry once.
    if (error instanceof ExitedBeforeStartError && options.signal?.aborted !== true) {
      return startOnce(options);
    }
    throw error;
  }
};
