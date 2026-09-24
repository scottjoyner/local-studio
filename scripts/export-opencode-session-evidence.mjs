#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

const values = (name) => {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] !== undefined) result.push(argv[index + 1]);
  }
  return result;
};
const value = (name, fallback = null) => values(name).at(-1) ?? fallback;
const has = (name) => argv.includes(name);

if (has("--help")) {
  process.stdout.write(
    [
      "Usage: node scripts/export-opencode-session-evidence.mjs [options]",
      "  --session <session-id>",
      "  --expected-model <model-id>",
      "  --expected-provider <provider-id>",
      "  --export-output <path>",
      "  --receipt-output <path>",
      "  --input-export <sanitized-export.json>  offline/test mode",
      "  --opencode-bin <binary>",
      "  --min-completed-tools <count>",
      "  --require-tool <tool-name>               repeatable",
      "",
      "The receipt is accepted only when the final user turn stays on the exact",
      "expected provider/model and completes the required tool round-trip.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const sessionId = value("--session");
const expectedModel = value("--expected-model");
const expectedProvider = value("--expected-provider");
const inputExport = value("--input-export");
const exportOutput = resolve(
  value("--export-output", sessionId ? `opencode-${sessionId}.sanitized.json` : "opencode-session.sanitized.json"),
);
const receiptOutput = resolve(
  value("--receipt-output", sessionId ? `opencode-${sessionId}.receipt.json` : "opencode-session.receipt.json"),
);
const opencodeBin = value("--opencode-bin", "opencode");
const minCompletedTools = Number(value("--min-completed-tools", "1"));
const requiredTools = values("--require-tool");

if (!expectedModel) throw new Error("--expected-model is required");
if (!Number.isInteger(minCompletedTools) || minCompletedTools < 1 || minCompletedTools > 100) {
  throw new Error("--min-completed-tools must be an integer from 1 to 100");
}
if (!inputExport && !sessionId) throw new Error("--session is required unless --input-export is used");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const command = (binary, args) => {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: Boolean(result.error && result.error.code === "ENOENT"),
  };
};

let raw;
let exportCommand;
let opencodeVersion = null;

if (inputExport) {
  raw = readFileSync(resolve(inputExport));
  exportCommand = ["input-export", basename(inputExport)];
} else {
  const version = command(opencodeBin, ["--version"]);
  if (version.missing) throw new Error(`OpenCode binary not found: ${opencodeBin}`);
  opencodeVersion = version.status === 0 ? version.stdout.trim() : null;

  let exported = command(opencodeBin, ["export", sessionId, "--sanitize"]);
  exportCommand = [opencodeBin, "export", sessionId, "--sanitize"];

  if (exported.status !== 0) {
    const fallback = command(opencodeBin, ["session", "export", sessionId, "--sanitize"]);
    if (fallback.status !== 0) {
      throw new Error(
        `OpenCode sanitized export failed: ${(fallback.stderr || exported.stderr || fallback.stdout || exported.stdout).trim()}`,
      );
    }
    exported = fallback;
    exportCommand = [opencodeBin, "session", "export", sessionId, "--sanitize"];
  }
  raw = Buffer.from(exported.stdout, "utf8");
}

let exported;
try {
  exported = JSON.parse(raw.toString("utf8"));
} catch (error) {
  throw new Error(`OpenCode export is not valid JSON: ${String(error)}`);
}

if (!exported || typeof exported !== "object") throw new Error("OpenCode export is not an object");
if (!exported.info || typeof exported.info !== "object") throw new Error("OpenCode export is missing info");
if (!Array.isArray(exported.messages)) throw new Error("OpenCode export is missing messages");

const actualSessionId = exported.info.id;
if (typeof actualSessionId !== "string" || !actualSessionId) {
  throw new Error("OpenCode export is missing info.id");
}
if (sessionId && actualSessionId !== sessionId) {
  throw new Error(`OpenCode export session mismatch: expected ${sessionId}, got ${actualSessionId}`);
}

const messages = exported.messages;
let lastUserIndex = -1;
for (let index = 0; index < messages.length; index += 1) {
  if (messages[index]?.info?.role === "user") lastUserIndex = index;
}
if (lastUserIndex < 0) throw new Error("OpenCode export has no user message");

const turnAssistants = messages
  .slice(lastUserIndex + 1)
  .filter((message) => message?.info?.role === "assistant");

const models = turnAssistants.map((message) => ({
  messageId: message.info.id ?? null,
  providerID: message.info.providerID ?? null,
  modelID: message.info.modelID ?? null,
}));

const providerAccepted =
  typeof expectedProvider === "string" &&
  expectedProvider.length > 0 &&
  models.length > 0 &&
  models.every((entry) => entry.providerID === expectedProvider);
const fallbackDetected = models.some(
  (entry) =>
    entry.modelID !== expectedModel ||
    (expectedProvider ? entry.providerID !== expectedProvider : false),
);
const assistantErrors = turnAssistants
  .filter((message) => message?.info?.error)
  .map((message) => ({
    messageId: message.info.id ?? null,
    name: message.info.error?.name ?? null,
  }));

const completedTools = [];
for (const message of turnAssistants) {
  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (part?.type !== "tool" || part?.state?.status !== "completed") continue;
    completedTools.push({
      messageId: message.info.id ?? null,
      callID: part.callID ?? null,
      tool: part.tool ?? null,
    });
  }
}

const completedToolNames = new Set(
  completedTools.map((entry) => entry.tool).filter((entry) => typeof entry === "string"),
);
const requiredToolsAccepted = requiredTools.every((tool) => completedToolNames.has(tool));
const toolRoundTripAccepted =
  completedTools.length >= minCompletedTools && requiredToolsAccepted;
const modelAccepted =
  turnAssistants.length > 0 &&
  models.every((entry) => entry.modelID === expectedModel);
const accepted =
  modelAccepted &&
  providerAccepted &&
  !fallbackDetected &&
  toolRoundTripAccepted &&
  assistantErrors.length === 0;

writeFileSync(exportOutput, raw);

const exportStat = {
  name: basename(exportOutput),
  sizeBytes: raw.length,
  sha256: sha256(raw),
};

const receipt = {
  schemaVersion: "local-studio/opencode-session-evidence/v1",
  capturedAt: new Date().toISOString(),
  sessionId: actualSessionId,
  source: {
    kind: inputExport ? "sanitized-export-file" : "opencode-cli-sanitized-export",
    opencodeVersion,
    command: exportCommand,
  },
  sanitizedExport: exportStat,
  expected: {
    providerID: expectedProvider,
    modelID: expectedModel,
    minCompletedTools,
    requiredTools,
  },
  acceptanceTurn: {
    userMessageId: messages[lastUserIndex]?.info?.id ?? null,
    assistantMessageIds: models.map((entry) => entry.messageId),
    models,
    completedTools,
    completedToolCount: completedTools.length,
    fallbackDetected,
    assistantErrors,
    modelAccepted,
    providerAccepted,
    requiredToolsAccepted,
    toolRoundTripAccepted,
  },
  accepted,
};

writeFileSync(receiptOutput, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

process.stdout.write(
  `${JSON.stringify(
    {
      receipt: receiptOutput,
      sanitizedExport: exportOutput,
      accepted,
      observedModels: models,
      completedToolCount: completedTools.length,
    },
    null,
    2,
  )}\n`,
);

if (!accepted) process.exitCode = 3;
