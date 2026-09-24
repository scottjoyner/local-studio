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
const HARNESSROUTER_HEAD =
  "250de65d6e690abdef40e39d21591b4a807984a3";
const HARNESSROUTER_DRIVER_BLOB_SHA1 =
  "7cb3516a14b4f947e396a20735db4eb419a3db12";
const SYSTEMONE_PROVIDER_BLOB_SHA1 =
  "008ddd09fe8e2c85ee3b8316cf25062c28b59c1c";
const SYSTEMONE_PACKAGE_MANIFEST_SHA256 =
  "3a69281583ccccefd3e4d5422939703c842b00b92e2bfa9fc374293a94e15a74";
const SYSTEMONE_CONFIG = [
  "version: 1",
  "instructions: >",
  "  Read the bounded Hermes heartbeat state and make exactly one advisory",
  "  recommendation. This harness never grants dispatch, approval, claims,",
  "  mutation, tool access, or routing authority. Choose only values offered by",
  "  the environment. An act recommendation is not permission to act. Opaque",
  "  fleet handles are preferences inside the already-authoritative eligible set.",
  "gate:",
  "  read: 0.5",
  "  write: 1.0",
  "  destructive: 1.0",
  "encoder:",
  "  history_steps: 1",
  "  budget_tokens: 4096",
  "escalate: true",
  "",
].join("\n");
const SYSTEMONE_CONFIG_SHA256 =
  "459cc500b481878aa1445a6176bb8a6b61db51981696afcc6dd65f9fe3700f4e";
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

function runVerifier(verifier, report, localHead, myJevHead) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      "--report",
      report,
      "--expected-local-head",
      localHead,
      "--expected-my-jev-head",
      myJevHead,
    ],
    { encoding: "utf8" },
  );
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const verifier = resolve(scriptDir, "verify-system-one-evidence.mjs");
const root = mkdtempSync(join(tmpdir(), "local-studio-system-one-hr-verify-"));

try {
  const systemOne = join(root, "system-one");
  const acceptanceDir = join(systemOne, "acceptance");
  const sessionsDir = join(systemOne, "sessions");
  const consumedDir = join(systemOne, "consumed");
  const responseId = "resp_harnessrouter_offline_verifier";
  const receiptId = "harnessrouter-offline-verifier-receipt";
  const producerDir = join(systemOne, "producer", responseId);
  const producerWorkspace = join(producerDir, "workspace");
  const producerPackage = join(producerDir, "package");
  mkdirSync(acceptanceDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(consumedDir, { recursive: true });
  mkdirSync(producerWorkspace, { recursive: true });
  mkdirSync(producerPackage, { recursive: true });

  const piSession = "pi-harnessrouter-offline-verifier";
  const uhpSessionId = "hsess-harnessrouter-offline-verifier";
  const canary = "UHP_HARNESSROUTER_OFFLINE_CANARY";
  const projectCwd = "/tmp/harnessrouter-offline-verifier-project";
  const projectFingerprint = "a".repeat(64);
  const modelId = "coding-model:test";
  const myJevHead = "2".repeat(40);
  const localStudioHead = "1".repeat(40);

  const sourceSnapshot = {
    schema_version: "hermes-heartbeat-snapshot-v1",
    observed_at: "2026-09-24T12:00:00Z",
    expires_at: "2026-09-24T12:05:00Z",
    work: {
      work_id: "work-harnessrouter-verifier",
      session_id: null,
      status: "active",
      goal: "Bounded verification.",
      priority: 50,
      blockers: [],
      pending_approvals: [],
      active_claims: [],
      last_action_class: null,
    },
    knowledge: {
      knowledge_revision: "knowledge-sha",
      markdown_revision: null,
      neo4j_snapshot_id: "neo4j-snapshot",
      note_refs: ["20-Projects/local-studio/CURRENT_STATE.md"],
      facts: [],
    },
    fleet: {
      projection_generation: "generation-1",
      projection_checksum: "fleet-sha",
      observation_snapshot_id: "observation-1",
      eligible_count: 1,
      eligible_handles: ["eligible:opaque:r9700-a"],
      drained_count: 0,
      unhealthy_count: 0,
      pressure: "light",
    },
    authority_context: {
      speaker_verified: false,
      actions_allowed: false,
      local_writes_allowed: false,
      external_actions_allowed: false,
      privileged_actions_allowed: false,
      approval_gate_available: false,
    },
    available_capabilities: [],
    available_tools: [],
    metadata: {},
  };
  const snapshotSha256 = canonicalSha256(sourceSnapshot);
  const sourceSnapshotPath = join(producerDir, "source-heartbeat-snapshot.json");
  writeFileSync(
    sourceSnapshotPath,
    JSON.stringify(sourceSnapshot, null, 2) + "\n",
    "utf8",
  );

  const trace = {
    config_version: 1,
    steps: [
      {
        action: "recommend",
        verdict: "run",
        action_confidence: 0.99,
      },
    ],
  };
  const tracePath = join(producerWorkspace, "trace.json");
  writeFileSync(tracePath, JSON.stringify(trace, null, 2) + "\n", "utf8");
  const traceSha256 = sha256(readFileSync(tracePath));

  const recommendation = {
    schema: "hermes-system-one-recommendation-v1",
    snapshot_sha256: snapshotSha256,
    advice: {
      mode: "act",
      fleet_handle: "eligible:opaque:r9700-a",
      context_focus: "20-Projects/local-studio/CURRENT_STATE.md",
    },
    authority: AUTHORITY,
    evidence_only: true,
    runtime_authority_changed: false,
  };
  const recommendationPath = join(
    producerWorkspace,
    "hermes-system-one-recommendation.json",
  );
  writeFileSync(
    recommendationPath,
    JSON.stringify(recommendation, null, 2) + "\n",
    "utf8",
  );

  const profile = {
    contract_sha256: CONTRACT_SHA256,
    receipt_id: receiptId,
    binding: {
      consumer: "local-studio",
      work_id: "work-harnessrouter-verifier",
      consumer_session_id: piSession,
      project_fingerprint: projectFingerprint,
      snapshot_sha256: snapshotSha256,
    },
    advice: {
      mode: "act",
      mode_confidence: 0.99,
      policy_disposition: null,
      approval_recommended: false,
      task_focus: canary,
      context_priority: ["20-Projects/local-studio/CURRENT_STATE.md"],
      fleet_priority: [
        {
          handle: "eligible:opaque:r9700-a",
          score: 0.99,
          reason: "observer-only rank inside the authoritative eligible fleet set",
        },
      ],
    },
    authority: AUTHORITY,
    provenance: {
      system_one_config_version: "1",
      model_revision: "script/s1",
      knowledge_revision: "knowledge-sha",
      neo4j_snapshot_id: "neo4j-snapshot",
      fleet_projection_generation: "generation-1",
      fleet_projection_checksum: "fleet-sha",
      trace_sha256: traceSha256,
    },
  };
  const stored = {
    id: responseId,
    object: "response",
    created_at: 0,
    status: "completed",
    error: null,
    incomplete_details: null,
    previous_response_id: null,
    model: "script/s1",
    output: [],
    store: true,
    usage: null,
    metadata: {
      session_id: uhpSessionId,
      harness_id: "chrn_system_one",
      hermes_system_one: profile,
    },
  };
  const producerStoredPath = join(producerDir, "stored-uhp-response.json");
  writeFileSync(
    producerStoredPath,
    JSON.stringify(stored, null, 2) + "\n",
    "utf8",
  );
  const fixturePath = join(sessionsDir, piSession + ".json");
  writeFileSync(fixturePath, readFileSync(producerStoredPath));
  const fixtureSha = sha256(readFileSync(fixturePath));

  const configPath = join(producerPackage, "config.yaml");
  writeFileSync(configPath, SYSTEMONE_CONFIG, "utf8");
  if (sha256(readFileSync(configPath)) !== SYSTEMONE_CONFIG_SHA256) {
    throw new Error("Synthetic config bytes drifted from the pinned hash");
  }

  const producerReport = {
    schema: "my-jev-harnessrouter-script-probe-v1",
    verdict: "pass",
    harnessrouter_head: HARNESSROUTER_HEAD,
    harnessrouter_driver_sha256: "f".repeat(64),
    harnessrouter_driver_git_blob_sha1: HARNESSROUTER_DRIVER_BLOB_SHA1,
    systemone_config_sha256: SYSTEMONE_CONFIG_SHA256,
    systemone_harness: {
      module: "/synthetic/systemone_harness/__init__.py",
      provider_sha256: "e".repeat(64),
      provider_git_blob_sha1: SYSTEMONE_PROVIDER_BLOB_SHA1,
      package_manifest_sha256: SYSTEMONE_PACKAGE_MANIFEST_SHA256,
      package_python_file_count: 20,
    },
    my_jev_head: myJevHead,
    source_snapshot: "/capture/source-heartbeat.json",
    source_snapshot_evidence: sourceSnapshotPath,
    source_snapshot_evidence_raw_sha256: sha256(readFileSync(sourceSnapshotPath)),
    snapshot_sha256: snapshotSha256,
    script_entry:
      "recommend(mode=act,fleet_handle=eligible:opaque:r9700-a,context_focus=20-Projects/local-studio/CURRENT_STATE.md)",
    result: {
      type: "result",
      is_error: false,
      model: "script/s1",
    },
    recommendation_sha256: sha256(readFileSync(recommendationPath)),
    trace_sha256: traceSha256,
    mode_confidence: 0.99,
    profile_sha256: canonicalSha256(profile),
    response_sha256: canonicalSha256(stored),
    stored_response_raw_sha256: sha256(readFileSync(producerStoredPath)),
    stored_response: producerStoredPath,
    consumer_session_id: piSession,
    project_fingerprint: projectFingerprint,
    receipt_id: receiptId,
    response_id: responseId,
    assertions: {},
  };
  const producerReportPath = join(
    producerDir,
    "harnessrouter-probe-evidence.json",
  );
  writeFileSync(
    producerReportPath,
    JSON.stringify(producerReport, null, 2) + "\n",
    "utf8",
  );

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
      served_model: "script/s1",
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
  const ledgerText =
    [...evidenceRows, ...replayRows]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  const ledgerPath = join(systemOne, "consumption.jsonl");
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

  const status = {
    modelId,
    cwd: projectCwd,
    piSessionId: piSession,
  };
  const report = {
    schema: "local-studio-system-one-one-turn-acceptance-v2",
    verdict: "pass",
    local_studio_head: localStudioHead,
    my_jev_head: myJevHead,
    producer_mode: "harnessrouter-script",
    snapshot_sha256: snapshotSha256,
    project_fingerprint: projectFingerprint,
    fixture_raw_sha256: fixtureSha,
    consume_marker_sha256: sha256(readFileSync(markerPath)),
    ledger_checkpoint: {
      bytes: Buffer.byteLength(ledgerText),
      sha256: sha256(Buffer.from(ledgerText, "utf8")),
    },
    response_id: responseId,
    receipt_id: receiptId,
    uhp_session_id: uhpSessionId,
    pi_session_id: piSession,
    task_focus_canary: canary,
    model_id: modelId,
    project_cwd: projectCwd,
    status_before: status,
    status_after: status,
    producer_evidence: producerReport,
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
      "Expected synthetic HarnessRouter bundle to pass:\n" +
        (valid.stderr || valid.stdout),
    );
  }
  const verified = JSON.parse(valid.stdout);
  if (verified.verdict !== "pass") {
    throw new Error("HarnessRouter-mode verifier returned non-pass");
  }

  sourceSnapshot.work.goal = "tampered after capture";
  writeFileSync(
    sourceSnapshotPath,
    JSON.stringify(sourceSnapshot, null, 2) + "\n",
    "utf8",
  );
  const tampered = runVerifier(verifier, reportPath, localStudioHead, myJevHead);
  if (tampered.status === 0) {
    throw new Error("Expected source snapshot tampering to fail");
  }
  const rejected = JSON.parse(tampered.stdout);
  if (
    rejected.verdict !== "fail" ||
    rejected.assertions.producer_source_snapshot_raw_hash_matches !== false ||
    rejected.assertions.producer_source_snapshot_canonical_hash_matches !== false
  ) {
    throw new Error("Verifier did not identify retained source snapshot tampering");
  }

  process.stdout.write(
    "System-One HarnessRouter offline verifier self-test passed.\n",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
