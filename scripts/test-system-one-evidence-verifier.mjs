#!/usr/bin/env node

import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CONTRACT_SHA256 =
  "5e88c73e7cbb2e46f3b5171951d2a84f0549633fbcb420458d56ae5ada0ffc8f";
const EVIDENCE_SIGNATURE_SCHEMA =
  "local-studio-system-one-acceptance-signature-v1";
const EVIDENCE_SIGNATURE_DOMAIN =
  "local-studio-system-one-acceptance-report-bytes-ed25519-v1";

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

function runVerifier(
  verifier,
  report,
  localHead,
  myJevHead,
  evidencePublicKeyPath = null,
  expectedEvidenceKeyId = null,
) {
  const args = [
    verifier,
    "--report",
    report,
    "--expected-local-head",
    localHead,
    "--expected-my-jev-head",
    myJevHead,
  ];
  if (evidencePublicKeyPath || expectedEvidenceKeyId) {
    args.push(
      "--evidence-public-key",
      evidencePublicKeyPath,
      "--expected-evidence-key-id",
      expectedEvidenceKeyId,
    );
  }
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const localStudioRoot = resolve(scriptDir, "..");
const verifier = resolve(scriptDir, "verify-system-one-evidence.mjs");
const root = mkdtempSync(join(tmpdir(), "local-studio-system-one-verify-"));

function gitHead(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("could not resolve Local Studio test HEAD");
  return result.stdout.trim();
}

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
  const localStudioHead = gitHead(localStudioRoot);
  const myJevHead = "2".repeat(40);

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
      provider_id: "provider-test",
      backend_model_id: "backend-test",
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
      task_focus_present: true,
      task_focus_sha256: sha256(canary),
      provider_model: "backend-test",
      expected_backend_model_id: "backend-test",
      provider_model_matches_expected: true,
      provider_tools: ["find", "grep", "ls", "read"],
      active_tools: ["find", "grep", "ls", "read"],
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
      selected_model_id_before: modelId,
      selected_model_id_after: modelId,
      selected_model_unchanged: true,
      provider_id_before: "provider-test",
      provider_id_after: "provider-test",
      backend_model_id_before: "backend-test",
      backend_model_id_after: "backend-test",
      provider_route_unchanged: true,
      cwd_fingerprint_before: projectFingerprint,
      cwd_fingerprint_after: projectFingerprint,
      cwd_unchanged: true,
      active_tools_at_injection: ["find", "grep", "ls", "read"],
      active_tools_sha256: canonicalSha256(["find", "grep", "ls", "read"]),
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

  const runtimeFiles = Object.fromEntries(
    [
      "services/agent-runtime/src/runtime-provenance.ts",
      "services/agent-runtime/src/system-one-advisory.ts",
      "services/agent-runtime/src/system-one-signature.ts",
      "services/agent-runtime/src/pi-runtime.ts",
      "services/agent-runtime/src/pi-runtime-types.ts",
      "services/agent-runtime/src/http/handlers.ts",
      "services/agent-runtime/src/server.ts",
      "services/agent-runtime/package.json",
      "services/agent-runtime/bun.lock",
    ].map((key) => [key, sha256(readFileSync(join(localStudioRoot, key)))]),
  );
  const runtimeProvenance = {
    schema: "local-studio-agent-runtime-provenance-v1",
    git_head: localStudioHead,
    source_clean: true,
    files: runtimeFiles,
    mode: "source",
    started_at: "2026-09-24T12:00:00.000Z",
    manifest_sha256: "8".repeat(64),
  };

  const report = {
    schema: "local-studio-system-one-one-turn-acceptance-v2",
    verdict: "pass",
    local_studio_head: localStudioHead,
    my_jev_head: myJevHead,
    runtime_provenance: runtimeProvenance,
    runtime_provenance_sha256: sha256(JSON.stringify(runtimeProvenance)),
    source_checkouts_clean: true,
    source_heads_stable: true,
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

  const valid = runVerifier(verifier, reportPath, localStudioHead, myJevHead);
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

  // The report signs/anchors a ledger prefix. Later appends, even for the same
  // receipt, must not retroactively change the historical acceptance verdict.
  appendFileSync(
    ledgerPath,
    JSON.stringify({
      outcome: "ignored",
      reason: "post_checkpoint_observation",
      response_id: responseId,
      receipt_id: receiptId,
    }) + "\n",
    "utf8",
  );
  const afterAppend = runVerifier(
    verifier,
    reportPath,
    localStudioHead,
    myJevHead,
  );
  if (afterAppend.status !== 0 || JSON.parse(afterAppend.stdout).verdict !== "pass") {
    throw new Error("Post-checkpoint ledger append changed historical verification");
  }

  const fixtureBytes = readFileSync(fixturePath);
  const outsideFixture = join(root, "outside-fixture.json");
  writeFileSync(outsideFixture, fixtureBytes);
  rmSync(fixturePath);
  symlinkSync(outsideFixture, fixturePath);
  const symlinked = runVerifier(
    verifier,
    reportPath,
    localStudioHead,
    myJevHead,
  );
  if (symlinked.status === 0) {
    throw new Error("Expected symlinked fixture evidence to fail");
  }
  rmSync(fixturePath);
  writeFileSync(fixturePath, fixtureBytes);

  const wrongHead = runVerifier(
    verifier,
    reportPath,
    "3".repeat(40),
    myJevHead,
  );
  if (wrongHead.status === 0) {
    throw new Error("Expected wrong reviewed Local Studio head to fail");
  }
  const wrongHeadResult = JSON.parse(wrongHead.stdout);
  if (wrongHeadResult.assertions.expected_local_head_matches !== false) {
    throw new Error("Verifier did not fail the wrong reviewed head");
  }

  report.runtime_provenance.git_head = "4".repeat(40);
  report.runtime_provenance_sha256 = sha256(
    JSON.stringify(report.runtime_provenance),
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  const staleRuntime = runVerifier(
    verifier,
    reportPath,
    localStudioHead,
    myJevHead,
  );
  if (staleRuntime.status === 0) {
    throw new Error("Expected stale running-runtime provenance to fail");
  }
  const staleRuntimeResult = JSON.parse(staleRuntime.stdout);
  if (staleRuntimeResult.assertions.runtime_provenance_head_matches !== false) {
    throw new Error("Verifier did not reject stale running-runtime provenance");
  }
  report.runtime_provenance.git_head = localStudioHead;
  report.runtime_provenance_sha256 = sha256(
    JSON.stringify(report.runtime_provenance),
  );

  report.evidence_rows[3].assistant_text_sha256 = "e".repeat(64);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const tampered = runVerifier(verifier, reportPath, localStudioHead, myJevHead);
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
  const modeTampered = runVerifier(verifier, reportPath, localStudioHead, myJevHead);
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

  // Restore the coherent fixture report, then add a distinct consumer-evidence
  // signature. These checks intentionally run after the unsigned invariant
  // attacks above so a valid outer signature cannot mask missing inner coverage.
  report.producer_mode = "fixture";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const evidencePublicKeyPath = join(root, "acceptance-public.pem");
  writeFileSync(
    evidencePublicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const evidenceDer = publicKey.export({ type: "spki", format: "der" });
  const expectedEvidenceKeyId = "ed25519:" + sha256(evidenceDer);
  report.evidence_signature_required = true;
  report.expected_evidence_key_id = expectedEvidenceKeyId;

  const signedReportRaw = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(reportPath, signedReportRaw, "utf8");
  const evidencePreimage = Buffer.concat([
    Buffer.from(EVIDENCE_SIGNATURE_DOMAIN + "\0", "utf8"),
    Buffer.from(signedReportRaw, "utf8"),
  ]);
  const evidenceEnvelope = {
    schema: EVIDENCE_SIGNATURE_SCHEMA,
    scheme: "ed25519",
    domain: EVIDENCE_SIGNATURE_DOMAIN,
    key_id: expectedEvidenceKeyId,
    report_sha256: sha256(Buffer.from(signedReportRaw, "utf8")),
    preimage_sha256: sha256(evidencePreimage),
    signature_b64: sign(null, evidencePreimage, privateKey).toString("base64"),
  };
  const evidenceSignaturePath = reportPath + ".sig.json";
  writeFileSync(
    evidenceSignaturePath,
    JSON.stringify(evidenceEnvelope, null, 2) + "\n",
    "utf8",
  );

  const signedValid = runVerifier(
    verifier,
    reportPath,
    localStudioHead,
    myJevHead,
    evidencePublicKeyPath,
    expectedEvidenceKeyId,
  );
  if (signedValid.status !== 0) {
    throw new Error(
      "Expected signed acceptance evidence to pass:\n" +
        (signedValid.stderr || signedValid.stdout),
    );
  }
  const signedVerified = JSON.parse(signedValid.stdout);
  if (
    signedVerified.verdict !== "pass" ||
    signedVerified.assertions.evidence_signature_cryptographically_valid !== true
  ) {
    throw new Error("Verifier did not authenticate signed acceptance evidence");
  }

  writeFileSync(
    reportPath,
    signedReportRaw.replace('"producer_mode": "fixture"', '"producer_mode": "tampered"'),
    "utf8",
  );
  const signedTamper = runVerifier(
    verifier,
    reportPath,
    localStudioHead,
    myJevHead,
    evidencePublicKeyPath,
    expectedEvidenceKeyId,
  );
  if (signedTamper.status === 0) {
    throw new Error("Expected one-byte signed-report tampering to fail");
  }
  const signedTamperResult = JSON.parse(signedTamper.stdout);
  if (
    signedTamperResult.assertions.evidence_signature_cryptographically_valid !== false
  ) {
    throw new Error("Verifier did not identify signed-report tampering");
  }

  writeFileSync(reportPath, signedReportRaw, "utf8");
  rmSync(evidenceSignaturePath);
  const strippedSignature = runVerifier(
    verifier,
    reportPath,
    localStudioHead,
    myJevHead,
    evidencePublicKeyPath,
    expectedEvidenceKeyId,
  );
  if (strippedSignature.status === 0) {
    throw new Error("Expected stripped acceptance signature to fail");
  }
  const strippedResult = JSON.parse(strippedSignature.stdout);
  if (strippedResult.assertions.evidence_signature_file_present !== false) {
    throw new Error("Verifier did not reject stripped acceptance signature");
  }

  process.stdout.write("System-One offline evidence verifier self-test passed.\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
