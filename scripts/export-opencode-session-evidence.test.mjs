#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "scripts", "export-opencode-session-evidence.mjs");
const temp = mkdtempSync(join(tmpdir(), "local-studio-opencode-evidence-"));

const run = (fixture, name) => {
  const input = join(temp, `${name}.json`);
  const output = join(temp, `${name}.sanitized.json`);
  const receipt = join(temp, `${name}.receipt.json`);
  writeFileSync(input, JSON.stringify(fixture, null, 2));
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--input-export",
      input,
      "--expected-provider",
      "local-studio",
      "--expected-model",
      "Ternary-Bonsai-2-27B-PQ2_0",
      "--min-completed-tools",
      "1",
      "--export-output",
      output,
      "--receipt-output",
      receipt,
    ],
    { encoding: "utf8" },
  );
  return { result, output, receipt };
};

try {
  const base = {
    info: { id: "ses_r9700", title: "[redacted]" },
    messages: [
      {
        info: {
          id: "msg_user_old",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "remote", modelID: "other-model" },
        },
        parts: [],
      },
      {
        info: {
          id: "msg_assistant_old",
          role: "assistant",
          parentID: "msg_user_old",
          providerID: "remote",
          modelID: "other-model",
          mode: "build",
          agent: "build",
          path: { cwd: "[redacted]", root: "[redacted]" },
          time: { created: 2, completed: 3 },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
      {
        info: {
          id: "msg_user_accept",
          role: "user",
          time: { created: 4 },
          agent: "build",
          model: {
            providerID: "local-studio",
            modelID: "Ternary-Bonsai-2-27B-PQ2_0",
          },
        },
        parts: [],
      },
      {
        info: {
          id: "msg_assistant_accept",
          role: "assistant",
          parentID: "msg_user_accept",
          providerID: "local-studio",
          modelID: "Ternary-Bonsai-2-27B-PQ2_0",
          mode: "build",
          agent: "build",
          path: { cwd: "[redacted]", root: "[redacted]" },
          time: { created: 5, completed: 8 },
          cost: 0,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "prt_tool",
            sessionID: "ses_r9700",
            messageID: "msg_assistant_accept",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { redacted: "tool-input:prt_tool" },
              output: "[redacted:tool-output:prt_tool]",
              title: "[redacted:tool-title:prt_tool]",
              metadata: {},
              time: { start: 6, end: 7 },
            },
          },
        ],
      },
    ],
  };

  const accepted = run(base, "accepted");
  if (accepted.result.status !== 0) {
    throw new Error(`accepted fixture failed: ${accepted.result.stderr || accepted.result.stdout}`);
  }
  const receipt = JSON.parse(readFileSync(accepted.receipt, "utf8"));
  if (receipt.schemaVersion !== "local-studio/opencode-session-evidence/v1") {
    throw new Error("unexpected receipt schema");
  }
  if (receipt.accepted !== true) throw new Error("accepted receipt is not accepted");
  if (receipt.acceptanceTurn.fallbackDetected !== false) throw new Error("old-turn fallback contaminated final-turn evidence");
  if (receipt.acceptanceTurn.completedToolCount !== 1) throw new Error("tool round-trip count mismatch");
  if (receipt.acceptanceTurn.models.length !== 1) throw new Error("acceptance turn model count mismatch");
  if (receipt.acceptanceTurn.models[0].providerID !== "local-studio") throw new Error("provider was not preserved");

  const fallback = structuredClone(base);
  fallback.messages.at(-1).info.providerID = "remote";
  const rejectedFallback = run(fallback, "fallback");
  if (rejectedFallback.result.status === 0) throw new Error("provider fallback was accepted");
  const fallbackReceipt = JSON.parse(readFileSync(rejectedFallback.receipt, "utf8"));
  if (fallbackReceipt.acceptanceTurn.fallbackDetected !== true) throw new Error("provider fallback was not detected");

  const noTool = structuredClone(base);
  noTool.messages.at(-1).parts = [];
  const rejectedTool = run(noTool, "no-tool");
  if (rejectedTool.result.status === 0) throw new Error("tool-less acceptance turn was accepted");

  process.stdout.write("OpenCode session evidence contract PASS\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
