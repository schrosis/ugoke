import { describe, expect, it } from "vitest";

import { createAiTerminalPlugin, reportAiFailure, writeAiLine } from "./ai.ts";
import type { AiQuestion } from "./ai.ts";
import { cancelledExitCode } from "./exit-codes.ts";
import { createOutput } from "./testing.ts";

describe("createAiTerminalPlugin", () => {
  it("reports the question, and waits until the command stops following the run", async () => {
    const questions: AiQuestion[] = [];
    const method = createAiTerminalPlugin((question) => questions.push(question)).waitMethods?.[0];
    const controller = new AbortController();
    if (method?.respond === undefined) {
      throw new Error("The plugin has no method that answers");
    }

    const answering = method.respond({
      answers: { ok: { required: true, type: "boolean" } },
      config: undefined,
      log: () => {},
      options: { message: "Deploy?", schema: {} },
      run: { inputs: { target: "prod" }, workflowId: "deploy-1" },
      signal: controller.signal,
      startedAt: new Date("2026-01-02T03:04:05.000Z"),
      step: "approve",
      visit: 1,
    });

    expect(method.name).toBe("terminal");
    expect(questions).toEqual([
      {
        answers: { ok: { required: true, type: "boolean" } },
        inputs: { target: "prod" },
        message: "Deploy?",
        step: "approve",
        type: "question",
        visit: 1,
        workflowId: "deploy-1",
      },
    ]);
    controller.abort(new Error("detached"));
    await expect(answering).rejects.toThrow("detached");
  });
});

describe("reportAiFailure", () => {
  it("ends the output with the messages when the command fails without a line", async () => {
    const output = createOutput();

    await expect(
      reportAiFailure(output, async ({ stderr }) => {
        stderr("Workflow not found: deploy\n");
        return 1;
      }),
    ).resolves.toBe(1);
    expect(output.written).toEqual({
      stderr: "Workflow not found: deploy\n",
      stdout: '{"message":"Workflow not found: deploy","type":"failed"}\n',
    });
  });

  it("ends the output with a cancelled line when the command is interrupted without a line", async () => {
    const output = createOutput();

    await expect(
      reportAiFailure(output, async ({ stderr }) => {
        stderr("deploy: cancelled\n");
        return cancelledExitCode;
      }),
    ).resolves.toBe(cancelledExitCode);
    expect(output.written).toEqual({
      stderr: "deploy: cancelled\n",
      stdout: '{"type":"cancelled"}\n',
    });
  });

  it("adds nothing when the command wrote its own lines", async () => {
    const output = createOutput();

    await reportAiFailure(output, async ({ stdout }) => {
      writeAiLine(stdout, { message: "Script exited with code 1", type: "failed" });
      return 1;
    });

    expect(output.written.stdout).toBe('{"message":"Script exited with code 1","type":"failed"}\n');
  });
});
