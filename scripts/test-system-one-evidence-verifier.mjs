#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CONTRACT_SHA256 =
  "5e88c73e7cbb2e46f3b5171951d2a84f0549633fbcb420458d56ae5ada0ffc8f";
const AUTHORITY = {
  dispatch_allowed: false,
  approval_granted: false,
  claim_acquired: false,
  mutation_allowed: false,
  routing_authority_changed: false,
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function runVerifier(verifier, report) {
  return spawnSync(process.execPath, [verifier, "--report", report], {
    encoding: "utf8",
  });
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const verifier = resolve(scriptDir, "verify-system-one-evidence.mjs");
const root = mkdtempSync(join(tmpdir(), "local-studio-system-one-verify-"));

try {
  const systemOne = join(root, "system-one");
  const acceptanceDir = join(systemOne, "acceptance");
  const sessionsDir = join(systemOne, "sessions");
  const consumedDir = join(systemOne, "consumed");
  mkdirSync(acceptanceDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(consumedDir, { recursive: true });

  const piSession = "pi-offline-verifier";
  const responseId = "resp_offline_verifier";
  const receiptId = "offline-verifier-receipt";
  const uhpSessionId = "hsess-offline-verifier";
  const canary = "UHP_OFFLINE_VERIFIER_CANARY";
  const projectCwd = "/tmp/offline-verifier-project";
  const projectFingerprint = "a".repeat(64);
  const snapshotSha256 = "b".repeat(64);
  const modelId = "coding-model:test";

  const profile = {
    contract_sha256: CONTRACT_SHA256,
    receipt_id: receiptId,
    binding: {
      consumer: "local-studio",
      consumer_session_id: piSession,
      project_fingerprint: projectFingerprint,
      snapshot_sha256: snapshotSha256,
    },
    advice: { task_focus: canary },
    authority: AUTHORITY,
  };
  const fixture = {
    id: responseId,
    status: "completed",
    model: "recorded/jev",
    metadata: {
      session_id: uhpSessionId,
      harness_id: "chrn_system_one",
      hermes_system_one: profile,
    },
  };
  const fixturePath = join(sessionsDir, piSession + ".json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n", "utf8");
  const fixtureSha = sha256(readFileSync(fixturePath));

  const status = {
    modelId,
    cwd: projectCwd,
    piSessionId: piSession,
  };
  const receiptSha = canonicalSha256(profile);
  const evidenceRows = [
    {
      outcome: "consumed",
      response_id: responseId,
      receipt_id: receiptId,
      response_sha256: fixtureSha,
      receipt_sha256: receiptSha,
      contract_sha256: CONTRACT_SHA256,
      harness_id: "chrn_system_one",
      binding: {
        consumerSessionId: piSession,
        projectFingerprint,
        snapshotSha256,
      },
      authority: AUTHORITY,
    },
    {
      outcome: "turn_boundary_captured",
      response_id: responseId,
      receipt_id: receiptId,
      selected_model_id: modelId,
      cwd_fingerprint: projectFingerprint,
      active_tools: ["read", "ls", "find", "grep"],
    },
    {
      outcome: "provider_request_observed",
      response_id: responseId,
      receipt_id: receiptId,
      provider_request_sha256: "d".repeat(64),
      advisory_marker_present: true,
      response_id_present: true,
      receipt_id_present: true,
      provider_model_matches_expected: true,
      provider_tools_match_active: true,
    },
    {
      outcome: "turn_completed",
      response_id: responseId,
      receipt_id: receiptId,
      provider_request_count: 1,
      tool_call_count: 0,
      task_focus_observed_in_agent_messages: true,
      task_focus_echo_exact: true,
      assistant_text_sha256: sha256(canary),
      selected_model_unchanged: true,
      provider_route_unchanged: true,
      cwd_unchanged: true,
      authority: AUTHORITY,
    },
  ];
  const replayRows = [
    {
      outcome: "ignored",
      reason: "replay_already_consumed",
      response_id: responseId,
      receipt_id: receiptId,
    },
  ];
  const ledgerPath = join(systemOne, "consumption.jsonl");
  const ledgerText = [...evidenceRows, ...replayRows]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";
  writeFileSync(ledgerPath, ledgerText, "utf8");

  const marker = {
    at: "2026-09-24T12:00:00.000Z",
    pi_session_id: piSession,
    receipt_id: receiptId,
    response_id: responseId,
    response_sha256: fixtureSha,
    receipt_sha256: receiptSha,
  };
  const markerKey = sha256(piSession + "\0" + receiptId);
  const markerPath = join(consumedDir, markerKey + ".json");
  writeFileSync(markerPath, JSON.stringify(marker), "utf8");

  const report = {
    schema: "local-studio-system-one-one-turn-acceptance-v2",
    verdict: "pass",
    local_studio_head: "1".repeat(40),
    my_jev_head: "2".repeat(40),
    producer_mode: "fixture",
    snapshot_sha256: snapshotSha256,
    project_fingerprint: projectFingerprint,
    fixture_raw_sha256: fixtureSha,
    response_id: responseId,
    receipt_id: receiptId,
    uhp_session_id: uhpSessionId,
    pi_session_id: piSession,
    task_focus_canary: canary,
    model_id: modelId,
    project_cwd: projectCwd,
    status_before: status,
    status_after: status,
    consume_marker_sha256: sha256(readFileSync(markerPath)),
    ledger_checkpoint: {
      bytes: Buffer.byteLength(ledgerText),
      sha256: sha256(Buffer.from(ledgerText, "utf8")),
    },
    producer_evidence: { profile_sha256: receiptSha },
    evidence_rows: evidenceRows,
    replay_control: {
      status_before: status,
      status_after: status,
      evidence_rows: replayRows,
    },
  };

  const reportPath = join(acceptanceDir, responseId + ".json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const valid = runVerifier(verifier, reportPath);
  if (valid.status !== 0) {
    throw new Error(
      "Expected synthetic valid bundle to pass:\n" +
        (valid.stderr || valid.stdout),
    );
  }
  const verified = JSON.parse(valid.stdout);
  if (verified.verdict !== "pass") {
    throw new Error("Verifier returned non-pass verdict for valid bundle");
  }

  report.evidence_rows[3].assistant_text_sha256 = "e".repeat(64);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const tampered = runVerifier(verifier, reportPath);
  if (tampered.status === 0) {
    throw new Error("Expected tampered assistant evidence to fail");
  }
  const rejected = JSON.parse(tampered.stdout);
  if (
    rejected.verdict !== "fail" ||
    rejected.assertions.completed_assistant_hash_matches_canary !== false ||
    rejected.assertions.report_rows_exist_in_durable_ledger !== false
  ) {
    throw new Error(
      "Verifier did not identify report tampering against the durable ledger/canary",
    );
  }

  report.evidence_rows[3].assistant_text_sha256 = sha256(canary);
  report.producer_mode = "harnessrouter-script";
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  const modeTampered = runVerifier(verifier, reportPath);
  if (modeTampered.status === 0) {
    throw new Error("Expected producer-mode tampering to fail");
  }
  const modeRejected = JSON.parse(modeTampered.stdout);
  if (
    modeRejected.verdict !== "fail" ||
    modeRejected.assertions.producer_mode_matches_fixture_model !== false
  ) {
    throw new Error("Verifier did not reject producer-mode / served-model mismatch");
  }

  process.stdout.write("System-One offline evidence verifier self-test passed.\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
