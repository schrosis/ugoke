/** Temporal Server that a command names with `--address`. */
export interface ServerOptions {
  type: "address";
  address: string;
}

/** A Temporal Server that a command connects to. */
export interface OpenedServer {
  address: string;
  /** Options that reach the same server again, such as ` --address localhost:7233`. */
  options: string;
}

/** Quotes a value for a shell command line when it needs quotes. */
export const quote = (value: string): string =>
  /^[\w./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Returns the command line options that reach a server, such as `--address localhost:7233`.
 *
 * The resident process reports its options, and a command compares them with its own, so both
 * are built here to keep the same order.
 */
export const serverArguments = (server: ServerOptions): string[] => ["--address", server.address];

/** Returns the server that a command connects to at the address of the options. */
export const openServer = (server: ServerOptions): OpenedServer => ({
  address: server.address,
  options: ` ${serverArguments(server).map(quote).join(" ")}`,
});
