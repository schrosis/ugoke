import { createRequire } from "node:module";
import { WriteStream } from "node:tty";

import { configureRuntime } from "@ugoke/engine";
import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";

import { answerInboxCommand, listInboxCommand } from "./commands/inbox.js";
import type { CommandContext } from "./commands/load.js";
import { log } from "./commands/log.js";
import { attach, cancel } from "./commands/attach.js";
import { run } from "./commands/run.js";
import { showDaemonStatus, startDaemon, stopDaemon } from "./daemon/commands.js";
import { runDaemon } from "./daemon/process.js";
import type { ServerOptions } from "./server.js";
import { createTrustStore, ensureTrustedProject } from "./trust.js";
import { askTrustInTerminal } from "./trust-prompt.js";
import { docs } from "./commands/docs.js";
import { init } from "./commands/init.js";
import { schema } from "./commands/schema.js";
import { validate } from "./commands/validate.js";

const readVersion = (): string => {
  const manifest: unknown = createRequire(import.meta.url)("../package.json");
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("The package version is missing");
};

/** Environment of the program, injectable for tests. */
export interface ProgramContext extends CommandContext {
  setExitCode: (code: number) => void;
  /**
   * Returns a signal that is aborted when the user interrupts the program.
   *
   * Commands call it only when they can be cancelled, so that other commands keep the default
   * behavior of an interrupt.
   */
  interruptSignal: () => AbortSignal;
  /** Prepares the workflow engine before a command runs a workflow. */
  prepareEngine: () => void;
  /** Returns a signal that is aborted on SIGTERM or SIGINT, for the resident process. */
  stopSignal?: () => AbortSignal;
  /** Path of the ugoke executable, which `ugoke daemon start` runs in the background. */
  executable?: string;
}

/** Exit code of an interrupted program, following the shell convention for SIGINT. */
const interruptedExitCode = 130;

/** Handles an interrupt of the command that runs a workflow, once it has asked for the signal. */
let handleInterrupt: (() => void) | undefined;

const interruptSignal = (): AbortSignal => {
  const controller = new AbortController();
  handleInterrupt = () => {
    if (controller.signal.aborted) {
      // A second interrupt exits immediately.
      process.exit(interruptedExitCode);
    }
    controller.abort();
  };
  process.on("SIGINT", handleInterrupt);
  return controller.signal;
};

/**
 * Interrupts the command as Ctrl+C does, for prompts that read Ctrl+C as a key.
 *
 * It calls the handler of SIGINT directly instead of sending the signal, because sending SIGINT
 * on Windows ends the process without running the handler.
 */
const interrupt = (): void => {
  if (handleInterrupt === undefined) {
    process.exit(interruptedExitCode);
  }
  handleInterrupt();
};

/**
 * Configures the Temporal runtime once, only for commands that run workflows.
 *
 * An installed runtime keeps the process alive until a Worker shuts it down, so commands that
 * finish without running a workflow must not install it.
 */
const prepareEngine = (() => {
  let prepared = false;
  return (): void => {
    if (!prepared) {
      // The CLI reports failures and handles SIGINT itself.
      configureRuntime({ logLevel: "ERROR" });
      prepared = true;
    }
  };
})();

const stopSignal = (): AbortSignal => {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return controller.signal;
};

/**
 * Returns whether to color the text of a stream.
 *
 * A terminal follows NO_COLOR, FORCE_COLOR, and what it supports. Another stream, such as a pipe
 * or a file, is colored only when FORCE_COLOR asks for it, as Node reads it.
 */
export const colorsOf = (stream: {
  isTTY?: boolean;
  hasColors?: (() => boolean) | undefined;
}): boolean => {
  if (stream.isTTY === true && stream.hasColors !== undefined) {
    return stream.hasColors();
  }
  const force = process.env.FORCE_COLOR;
  // 16 colors are what hasColors() asks for by default.
  return (
    force !== undefined && WriteStream.prototype.hasColors.call(stream, 16, { FORCE_COLOR: force })
  );
};

const processContext = (): ProgramContext => ({
  // The question goes to standard error, so that the output of a command can still be redirected.
  askTrust:
    process.stdin.isTTY && process.stderr.isTTY
      ? async (root) => askTrustInTerminal(root, { input: process.stdin, output: process.stderr })
      : undefined,
  colors: { stderr: colorsOf(process.stderr), stdout: colorsOf(process.stdout) },
  columns: process.stdout.isTTY ? () => process.stdout.columns : undefined,
  cwd: process.cwd(),
  executable: process.argv[1] ?? "ugoke",
  interrupt,
  interruptSignal,
  stopSignal,
  prepareEngine,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  stderr: (text) => process.stderr.write(text),
  stdin: () => process.stdin,
  stdout: (text) => process.stdout.write(text),
  trustStore: createTrustStore(),
});

const daemonHelp = `
Without --address, the command uses temporal.address in .ugoke/config.yaml, or the
Temporal Server of the resident process that "ugoke daemon start" starts. When the resident
process runs, it runs the steps on that server, so the run keeps going after this command exits.`;
const interruptHelp = `
Press Ctrl+C to detach: the run waits in Temporal, and "ugoke attach" continues it.
A running script finishes first. Press Ctrl+C again to exit now, which fails the running
step so that the run cannot be continued. Use "ugoke cancel" to stop a run.`;

/**
 * Builds the server options of a command.
 *
 * @returns The server, or `undefined` when no option names one, so that the configuration file or
 *   the resident process gives it.
 */
const toServerOptions = (address: string | undefined): ServerOptions | undefined =>
  address === undefined ? undefined : { address, type: "address" };

/** Parses a whole number from 0, such as the value of `--visit` or `--tail`. */
const parseCount = (value: string): number => {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError("Enter a whole number from 0");
  }
  return Number(value);
};

/** Creates the `ugoke` command line program. */
export const createProgram = (context: ProgramContext = processContext()) => {
  const version = readVersion();
  const program = new Command()
    .name("ugoke")
    .description("Run workflows that combine AI, people, and scripts")
    .version(version);

  /**
   * Asks whether to trust the project before a command reads it, and returns whether the command
   * must end, with its exit code set.
   */
  const refuses = async (fromAi?: boolean): Promise<boolean> => {
    const exitCode = await ensureTrustedProject(context, fromAi === true);
    if (exitCode !== undefined) {
      context.setExitCode(exitCode);
    }
    return exitCode !== undefined;
  };

  program.commandsGroup("Getting started:");

  program
    .command("init")
    .description(
      "Create .ugoke in the current directory with a configuration file, a sample workflow, and JSON Schemas",
    )
    .action(async () => {
      context.setExitCode(await init(context));
    });

  // The help command is listed with the commands to start with, instead of in a group of its own.
  program.helpCommand(true);

  program.commandsGroup("Run workflows:");

  program
    .command("run")
    .description("Run a workflow in .ugoke/workflows and wait for it to finish")
    .argument("<workflow>", "workflow name, such as deploy or release/notes")
    .option("--address <address>", "address of the Temporal Server")
    .option("--input <json-or-file>", "workflow input as a JSON object or the path of a .json file")
    .addOption(
      new Option(
        "--detach",
        "start the run and exit. ugoke daemon runs it, and its questions wait in ugoke inbox list",
      ).conflicts("address"),
    )
    .addOption(
      new Option(
        "--from-ai",
        "write JSON lines for a program such as an AI agent, and exit at the first question, which ugoke inbox answer --from-ai answers",
      ).conflicts("detach"),
    )
    .addHelpText(
      "after",
      `${interruptHelp}
${daemonHelp}`,
    )
    .action(async (workflow, { address, detach, fromAi, input }) => {
      if (await refuses(fromAi)) {
        return;
      }
      const server = toServerOptions(address);
      const signal = context.interruptSignal();
      context.setExitCode(
        await run(
          workflow,
          {
            version,
            detach,
            fromAi,
            input,
            prepareEngine: context.prepareEngine,
            server,
            signal,
          },
          context,
        ),
      );
    });

  program
    .command("attach")
    .description("Attach to a run of the project and follow it, such as one that was detached")
    .argument("[workflow-id]", "ID of the run. Without it, the runs of the project are listed")
    .option("--address <address>", "address of the Temporal Server")
    .option("--force", "attach to a run that another version of ugoke started, which can fail")
    .addHelpText(
      "after",
      `${interruptHelp}
${daemonHelp}`,
    )
    .action(async (workflowId, { address, force }) => {
      if (await refuses()) {
        return;
      }
      const server = toServerOptions(address);
      const signal = context.interruptSignal();
      context.setExitCode(
        await attach(
          {
            version,
            force,
            prepareEngine: context.prepareEngine,
            server,
            signal,
            workflowId,
          },
          context,
        ),
      );
    });

  program
    .command("cancel")
    .description("Cancel a run of the project, stopping its wait or its running script")
    .argument("[workflow-id]", "ID of the run. Without it, the runs of the project are listed")
    .option("--address <address>", "address of the Temporal Server")
    .action(async (workflowId, { address }) => {
      if (await refuses()) {
        return;
      }
      const server = toServerOptions(address);
      const signal = context.interruptSignal();
      context.setExitCode(
        await cancel(
          {
            version,
            prepareEngine: context.prepareEngine,
            server,
            signal,
            workflowId,
          },
          context,
        ),
      );
    });

  const inbox = program
    .command("inbox")
    .description("List and answer the wait steps of the project that wait for someone to answer");

  inbox
    .command("list")
    .description("List the wait steps that wait for an answer, with the command that answers each")
    .option("--from-ai", "write a JSON line for each question, for a program such as an AI agent")
    .addOption(new Option("--address <address>", "address of the Temporal Server"))
    .action(async ({ address, fromAi }) => {
      if (await refuses(fromAi)) {
        return;
      }
      context.setExitCode(
        await listInboxCommand(
          {
            fromAi,
            server: toServerOptions(address),
            version,
          },
          context,
        ),
      );
    });

  inbox
    .command("answer")
    .description("Answer a wait step of a run, such as one that ugoke inbox list shows")
    .argument("<workflow-id>", "ID of the run")
    .requiredOption("--step <step>", "ID of the waiting step")
    .option("--visit <number>", "visit of the step, which ugoke inbox list shows", parseCount)
    .requiredOption(
      "--values <json-or-file>",
      "answers as a JSON object or the path of a .json file",
    )
    .addOption(
      new Option(
        "--from-ai",
        "follow the run after answering until its next question or its end, writing JSON lines for a program such as an AI agent",
      ).conflicts("detach"),
    )
    .option("--detach", "exit after answering. The run goes on in ugoke daemon")
    .addOption(new Option("--address <address>", "address of the Temporal Server"))
    .addHelpText(
      "after",
      `
One of --from-ai and --detach is required. --detach needs a run that ugoke daemon runs, such
as a run that was detached from "ugoke run". To answer a run and follow it in the terminal, use
"ugoke attach".`,
    )
    .action(async (workflowId, { address, detach, fromAi, step, values, visit }, command) => {
      if (detach !== true && fromAi !== true) {
        command.error("error: ugoke inbox answer needs --from-ai or --detach");
      }
      if (await refuses(fromAi)) {
        return;
      }
      context.setExitCode(
        await answerInboxCommand(
          {
            fromAi,
            prepareEngine: context.prepareEngine,
            server: toServerOptions(address),
            signal: context.interruptSignal(),
            step,
            values,
            version,
            visit,
            workflowId,
          },
          context,
        ),
      );
    });

  program
    .command("log")
    .description("Show the progress of a run of the project, also after it ended")
    .argument("<workflow-id>", "ID of the run, such as ugoke run and ugoke inbox list show")
    .option("--tail <lines>", "show only the last lines of the progress so far", parseCount)
    .option("--follow", "keep showing the progress until the run ends")
    .option("--json", "write each event as a line of JSON")
    .addOption(new Option("--address <address>", "address of the Temporal Server"))
    .addHelpText(
      "after",
      `
Both the standard output and the standard error of the steps are shown on standard output.
--follow asks the Temporal Server whether the run still runs.`,
    )
    .action(async (workflowId, { address, follow, json, tail }) => {
      if (await refuses()) {
        return;
      }
      context.setExitCode(
        await log(
          {
            follow,
            json,
            server: toServerOptions(address),
            signal: context.interruptSignal(),
            tail,
            version,
            workflowId,
          },
          context,
        ),
      );
    });

  program.commandsGroup("Write workflows:");

  program
    .command("validate")
    .description("Validate a workflow definition in .ugoke/workflows")
    .argument("<workflow>", "workflow name, such as deploy or release/notes")
    .action(async (workflow) => {
      if (await refuses()) {
        return;
      }
      context.setExitCode(await validate(workflow, context));
    });

  program
    .command("schema")
    .description(
      "Generate the JSON Schemas of the workflows and .ugoke/config.yaml in .ugoke/schemas, with the plugins of the project",
    )
    .addHelpText(
      "after",
      `
Refer to them with $schema at the top of each file, which editors use for completion:
  $schema: ../schemas/workflow.schema.json   (in .ugoke/workflows/deploy.yaml)
  $schema: ./schemas/config.schema.json      (in .ugoke/config.yaml)
Run it again after changing plugins.`,
    )
    .action(async () => {
      if (await refuses()) {
        return;
      }
      context.setExitCode(await schema(context));
    });

  program
    .command("docs")
    .description("Generate a Markdown document next to each workflow definition")
    .argument("[workflow]", "workflow name, such as deploy or release/notes. Defaults to all")
    .action(async (workflow) => {
      if (await refuses()) {
        return;
      }
      context.setExitCode(await docs(workflow, context));
    });

  program.commandsGroup("Background:");

  const daemon = program
    .command("daemon")
    .description(
      "Manage the resident process of this host, which keeps runs going in the background",
    );

  daemon
    .command("start")
    .description("Start the resident process in the background")
    .addHelpText(
      "after",
      `
The resident process starts a Temporal development server, which keeps its runs in
temporal.db in the state directory, such as ~/.local/state/ugoke.
With --address, it uses that Temporal Server instead.

Scripts that the resident process runs inherit its environment variables as they were when it
started, not those of the terminal that runs "ugoke run". Pass the values that a workflow needs
with env and dotenv in the definition.`,
    )
    .option(
      "--address <address>",
      "use the Temporal Server at this address instead of starting a development server",
    )
    .action(async ({ address }) => {
      context.setExitCode(
        await startDaemon(
          {
            executable: context.executable ?? "ugoke",
            server: toServerOptions(address),
            version,
          },
          context,
        ),
      );
    });

  daemon
    .command("stop")
    .description("Stop the resident process")
    .action(async () => {
      context.setExitCode(await stopDaemon(context));
    });

  daemon
    .command("status")
    .description("Show the state of the resident process")
    .action(async () => {
      context.setExitCode(await showDaemonStatus(context));
    });

  // ugoke daemon start runs this command in the background.
  daemon
    .command("run", { hidden: true })
    .option("--address <address>")
    .action(async ({ address }) => {
      const server = toServerOptions(address);
      const signal = (context.stopSignal ?? context.interruptSignal)();
      context.setExitCode(
        await runDaemon({ prepareEngine: context.prepareEngine, server, signal, version }, context),
      );
    });

  return program;
};
