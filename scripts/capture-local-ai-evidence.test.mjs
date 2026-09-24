#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const exporter = join(repoRoot, "scripts", "export-opencode-session-evidence.mjs");
const capture = join(repoRoot, "scripts", "capture-local-ai-evidence.mjs");
const temp = mkdtempSync(join(tmpdir(), "local-studio-capture-opencode-"));

const MODEL = "Ternary-Bonsai-2-27B-PQ2_0";
const PROVIDER = "local-studio";
const SESSION = "ses_r9700";

const runCapture = ({ receipt, exported, output, sessionFile = receipt }) =>
  spawnSync(
    process.execPath,
    [
      capture,
      "--output",
      output,
      "--model",
      MODEL,
      "--opencode",
      "--opencode-session",
      SESSION,
      "--opencode-receipt",
      receipt,
      "--opencode-export",
      exported,
      "--session",
      `opencode=${sessionFile}`,
    ],
    { encoding: "utf8" },
  );

try {
  const input = join(temp, "input.json");
  const exported = join(temp, "session.sanitized.json");
  const receipt = join(temp, "session.receipt.json");

  writeFileSync(
    input,
    JSON.stringify({
      info: { id: SESSION, title: "[redacted]" },
      messages: [
        {
          info: {
            id: "msg_user",
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: PROVIDER, modelID: MODEL },
          },
          parts: [],
        },
        {
          info: {
            id: "msg_assistant",
            role: "assistant",
            parentID: "msg_user",
            providerID: PROVIDER,
            modelID: MODEL,
            mode: "build",
            agent: "build",
            path: { cwd: "[redacted]", root: "[redacted]" },
            time: { created: 2, completed: 4 },
            cost: 0,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: "prt_tool",
              sessionID: SESSION,
              messageID: "msg_assistant",
              type: "tool",
              callID: "call_1",
              tool: "bash",
              state: {
                status: "completed",
                input: { redacted: "tool-input" },
                output: "[redacted]",
                title: "[redacted]",
                metadata: {},
                time: { start: 2, end: 3 },
              },
            },
          ],
        },
      ],
    }),
  );

  const exportResult = spawnSync(
    process.execPath,
    [
      exporter,
      "--input-export",
      input,
      "--expected-provider",
      PROVIDER,
      "--expected-model",
      MODEL,
      "--export-output",
      exported,
      "--receipt-output",
      receipt,
    ],
    { encoding: "utf8" },
  );
  if (exportResult.status !== 0) {
    throw new Error(`fixture export failed: ${exportResult.stderr || exportResult.stdout}`);
  }

  const acceptedOutput = join(temp, "accepted.manifest.json");
  const accepted = runCapture({ receipt, exported, output: acceptedOutput });
  if (accepted.status !== 0) {
    throw new Error(`capture failed accepted fixture: ${accepted.stderr || accepted.stdout}`);
  }
  const acceptedManifest = JSON.parse(readFileSync(acceptedOutput, "utf8"));
  if (acceptedManifest.clients?.opencode?.sessionEvidence?.accepted !== true) {
    throw new Error("linked OpenCode receipt/export was not accepted");
  }
  if (acceptedManifest.summary?.opencodeSessionEvidenceAccepted !== true) {
    throw new Error("summary did not credit verified OpenCode evidence");
  }
  if (acceptedManifest.summary?.sessionEvidenceAccepted !== true) {
    throw new Error("verified OpenCode evidence did not satisfy session gate");
  }

  // Same JSON semantics, different bytes: receipt hash must no longer match.
  const tamperedExport = join(temp, "session.tampered.json");
  writeFileSync(tamperedExport, `${readFileSync(exported, "utf8").trim()}\n\n`);
  const tamperedOutput = join(temp, "tampered.manifest.json");
  const tampered = runCapture({ receipt, exported: tamperedExport, output: tamperedOutput });
  if (tampered.status !== 0) {
    throw new Error(`capture process unexpectedly failed tamper fixture: ${tampered.stderr}`);
  }
  const tamperedManifest = JSON.parse(readFileSync(tamperedOutput, "utf8"));
  if (tamperedManifest.clients?.opencode?.sessionEvidence?.accepted !== false) {
    throw new Error("tampered export was accepted");
  }
  if (
    !tamperedManifest.clients.opencode.sessionEvidence.failures.includes("export-sha256-mismatch")
  ) {
    throw new Error("tampered export SHA mismatch was not reported");
  }
  if (tamperedManifest.summary?.opencodeSessionEvidenceAccepted !== false) {
    throw new Error("tampered export still received OpenCode promotion credit");
  }

  // Receipt/provider claim and export must agree independently.
  const providerReceipt = join(temp, "provider-mismatch.receipt.json");
  const providerData = JSON.parse(readFileSync(receipt, "utf8"));
  providerData.expected.providerID = "other-provider";
  writeFileSync(providerReceipt, JSON.stringify(providerData, null, 2));
  const providerOutput = join(temp, "provider.manifest.json");
  const provider = runCapture({ receipt: providerReceipt, exported, output: providerOutput });
  if (provider.status !== 0) {
    throw new Error(`capture process unexpectedly failed provider fixture: ${provider.stderr}`);
  }
  const providerManifest = JSON.parse(readFileSync(providerOutput, "utf8"));
  if (
    !providerManifest.clients.opencode.sessionEvidence.failures.includes(
      "export-provider-model-fallback",
    )
  ) {
    throw new Error("receipt/export provider mismatch was not independently detected");
  }

  // Legacy file-only evidence is retained diagnostically but cannot satisfy promotion.
  const legacyOutput = join(temp, "legacy.manifest.json");
  const legacy = spawnSync(
    process.execPath,
    [
      capture,
      "--output",
      legacyOutput,
      "--model",
      MODEL,
      "--opencode",
      "--session",
      `opencode=${receipt}`,
    ],
    { encoding: "utf8" },
  );
  if (legacy.status !== 0) {
    throw new Error(`legacy capture process failed: ${legacy.stderr}`);
  }
  const legacyManifest = JSON.parse(readFileSync(legacyOutput, "utf8"));
  if (legacyManifest.summary?.opencodeSessionEvidenceAccepted !== false) {
    throw new Error("legacy file-only OpenCode evidence received promotion credit");
  }
  if (legacyManifest.summary?.sessionEvidenceAccepted !== false) {
    throw new Error("legacy file-only OpenCode evidence satisfied session gate");
  }

  process.stdout.write("OpenCode receipt binding contract PASS\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
