#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

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
const SYSTEMONE_CONFIG_SHA256 =
  "459cc500b481878aa1445a6176bb8a6b61db51981696afcc6dd65f9fe3700f4e";
const AUTHORITY_KEYS = [
  "dispatch_allowed",
  "approval_granted",
  "claim_acquired",
  "mutation_allowed",
  "routing_authority_changed",
];
const INFLUENCE_OUTCOMES = new Set([
  "consumed",
  "turn_boundary_captured",
  "provider_request_observed",
  "turn_completed",
]);
const READ_ONLY_TOOLS = ["find", "grep", "ls", "read"];

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error("Unexpected argument: " + key);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("Missing value for " + key);
    }
    values.set(key.slice(2), value);
    i += 1;
  }
  return values;
}

function required(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error("--" + name + " is required");
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalSha256(value) {
  return sha256(canonicalJson(value));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function rowFingerprint(row) {
  return canonicalSha256(row);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isGitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isSafePathSegment(value, maxLength = 256) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== "." &&
    value !== ".."
  );
}

function allAuthorityFalse(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    AUTHORITY_KEYS.every((key) => value[key] === false) &&
    Object.keys(value).every((key) => AUTHORITY_KEYS.includes(key))
  );
}

function sameStrings(left, right) {
  const a = [...new Set(left ?? [])].sort();
  const b = [...new Set(right ?? [])].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function exactlyOne(rows, outcome) {
  const found = (rows ?? []).filter((row) => row?.outcome === outcome);
  return found.length === 1 ? found[0] : null;
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(label + " does not exist: " + path);
  }
  return path;
}

function requireBundleFile(systemOneDir, path, label) {
  requireFile(path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(label + " must be a regular non-symlink file: " + path);
  }
  const root = realpathSync(systemOneDir);
  const target = realpathSync(path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(label + " escapes the retained system-one bundle: " + path);
  }
  return path;
}

function consumeMarkerPath(systemOneDir, piSessionId, receiptId) {
  const key = sha256(piSessionId + "\0" + receiptId);
  return join(systemOneDir, "consumed", key + ".json");
}

function rowsAppearInOrder(ledgerRows, expectedRows) {
  let cursor = 0;
  for (const expected of expectedRows) {
    const fingerprint = rowFingerprint(expected);
    let found = false;
    for (; cursor < ledgerRows.length; cursor += 1) {
      if (rowFingerprint(ledgerRows[cursor]) === fingerprint) {
        cursor += 1;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function verifyProducer(report, systemOneDir, fixtureSha) {
  if (report.producer_mode !== "harnessrouter-script") {
    return {
      assertions: {
        producer_mode_is_fixture: report.producer_mode === "fixture",
        producer_evidence_present:
          report.producer_evidence !== null &&
          typeof report.producer_evidence === "object",
      },
      files: null,
    };
  }

  const producerDir = join(systemOneDir, "producer", report.response_id);
  const producerReportPath = join(
    producerDir,
    "harnessrouter-probe-evidence.json",
  );
  const recommendationPath = join(
    producerDir,
    "workspace",
    "hermes-system-one-recommendation.json",
  );
  const tracePath = join(producerDir, "workspace", "trace.json");
  const storedResponsePath = join(producerDir, "stored-uhp-response.json");
  const sourceSnapshotPath = join(producerDir, "source-heartbeat-snapshot.json");
  const configPath = join(producerDir, "package", "config.yaml");
  const paths = [
    [producerReportPath, "HarnessRouter producer report"],
    [recommendationPath, "HarnessRouter recommendation"],
    [tracePath, "HarnessRouter trace"],
    [storedResponsePath, "HarnessRouter stored response"],
    [sourceSnapshotPath, "HarnessRouter source snapshot"],
    [configPath, "HarnessRouter System-One config"],
  ];
  try {
    for (const [path, label] of paths) {
      requireBundleFile(systemOneDir, path, label);
    }
  } catch {
    return {
      assertions: { producer_bundle_files_present: false },
      files: null,
    };
  }

  const producer = readJson(producerReportPath);
  const recommendation = readJson(recommendationPath);
  const trace = readJson(tracePath);
  const stored = readJson(storedResponsePath);
  const sourceSnapshot = readJson(sourceSnapshotPath);
  const profile = stored?.metadata?.hermes_system_one;
  const recommendSteps = Array.isArray(trace?.steps)
    ? trace.steps.filter((step) => step?.action === "recommend")
    : [];

  return {
    assertions: {
      producer_bundle_files_present: true,
      producer_schema:
        producer.schema === "my-jev-harnessrouter-script-probe-v1",
      producer_harnessrouter_head_pinned:
        producer.harnessrouter_head === HARNESSROUTER_HEAD,
      producer_harnessrouter_driver_blob_pinned:
        producer.harnessrouter_driver_git_blob_sha1 ===
        HARNESSROUTER_DRIVER_BLOB_SHA1,
      producer_systemone_provider_blob_pinned:
        producer?.systemone_harness?.provider_git_blob_sha1 ===
        SYSTEMONE_PROVIDER_BLOB_SHA1,
      producer_systemone_package_manifest_pinned:
        producer?.systemone_harness?.package_manifest_sha256 ===
        SYSTEMONE_PACKAGE_MANIFEST_SHA256,
      producer_systemone_config_pinned:
        producer.systemone_config_sha256 === SYSTEMONE_CONFIG_SHA256,
      producer_my_jev_head_matches: producer.my_jev_head === report.my_jev_head,
      producer_snapshot_matches:
        producer.snapshot_sha256 === report.snapshot_sha256 &&
        recommendation.snapshot_sha256 === report.snapshot_sha256,
      producer_source_snapshot_raw_hash_matches:
        producer.source_snapshot_evidence_raw_sha256 ===
        sha256File(sourceSnapshotPath),
      producer_source_snapshot_canonical_hash_matches:
        canonicalSha256(sourceSnapshot) === report.snapshot_sha256,
      producer_config_file_hash_matches:
        sha256File(configPath) === SYSTEMONE_CONFIG_SHA256 &&
        producer.systemone_config_sha256 === SYSTEMONE_CONFIG_SHA256,
      producer_recommendation_hash_matches:
        producer.recommendation_sha256 === sha256File(recommendationPath),
      producer_trace_hash_matches:
        producer.trace_sha256 === sha256File(tracePath),
      producer_stored_response_hash_matches:
        producer.stored_response_raw_sha256 === sha256File(storedResponsePath),
      producer_profile_canonical_hash_matches:
        producer.profile_sha256 === canonicalSha256(profile),
      producer_response_canonical_hash_matches:
        producer.response_sha256 === canonicalSha256(stored),
      producer_stored_response_matches_fixture:
        sha256File(storedResponsePath) === fixtureSha,
      producer_script_model:
        producer?.result?.model === "script/s1" &&
        stored?.model === "script/s1",
      producer_result_not_error: producer?.result?.is_error === false,
      producer_single_recommend:
        recommendSteps.length === 1 && recommendSteps[0]?.verdict === "run",
      producer_config_version_one: trace?.config_version === 1,
      producer_recommendation_evidence_only:
        recommendation?.evidence_only === true,
      producer_recommendation_authority_unchanged:
        recommendation?.runtime_authority_changed === false,
      producer_recommendation_authority_all_false:
        allAuthorityFalse(recommendation?.authority),
      producer_profile_authority_all_false:
        allAuthorityFalse(profile?.authority),
      producer_response_id_matches: stored?.id === report.response_id,
      producer_receipt_id_matches:
        producer.receipt_id === report.receipt_id &&
        profile?.receipt_id === report.receipt_id,
      producer_session_matches:
        producer.consumer_session_id === report.pi_session_id &&
        profile?.binding?.consumer_session_id === report.pi_session_id,
      producer_project_matches:
        producer.project_fingerprint === report.project_fingerprint &&
        profile?.binding?.project_fingerprint === report.project_fingerprint,
      producer_snapshot_binding_matches:
        profile?.binding?.snapshot_sha256 === report.snapshot_sha256,
      producer_trace_binding_matches:
        profile?.provenance?.trace_sha256 === sha256File(tracePath),
      producer_task_focus_matches:
        profile?.advice?.task_focus === report.task_focus_canary,
      producer_no_model_fallback:
        !("model_fallback" in (stored?.metadata ?? {})),
    },
    files: {
      report_path: producerReportPath,
      report_sha256: sha256File(producerReportPath),
      recommendation_sha256: sha256File(recommendationPath),
      trace_sha256: sha256File(tracePath),
      stored_response_sha256: sha256File(storedResponsePath),
      source_snapshot_raw_sha256: sha256File(sourceSnapshotPath),
      source_snapshot_canonical_sha256: canonicalSha256(sourceSnapshot),
      systemone_config_sha256: sha256File(configPath),
    },
  };
}

const args = parseArgs(process.argv.slice(2));
const reportPath = resolve(required(args, "report"));
requireFile(reportPath, "Acceptance report");

const report = readJson(reportPath);
if (
  !isSafePathSegment(report.pi_session_id) ||
  !isSafePathSegment(report.response_id) ||
  !String(report.response_id).startsWith("resp_")
) {
  throw new Error("Acceptance report contains unsafe session/response identifiers");
}
const systemOneDir = args.get("system-one-dir")
  ? resolve(args.get("system-one-dir"))
  : dirname(dirname(reportPath));
const fixturePath = requireBundleFile(
  systemOneDir,
  join(systemOneDir, "sessions", report.pi_session_id + ".json"),
  "Bound UHP fixture",
);
const fixtureSha = sha256File(fixturePath);
const fixture = readJson(fixturePath);
const profile = fixture?.metadata?.hermes_system_one;
const ledgerPath = requireBundleFile(
  systemOneDir,
  join(systemOneDir, "consumption.jsonl"),
  "System-One consumption ledger",
);
const markerPath = requireBundleFile(
  systemOneDir,
  consumeMarkerPath(systemOneDir, report.pi_session_id, report.receipt_id),
  "System-One consume marker",
);
const ledgerRaw = readFileSync(ledgerPath);
const ledgerRows = readJsonLines(ledgerPath);
const markerRaw = readFileSync(markerPath);
const marker = JSON.parse(markerRaw.toString("utf8"));
const rows = Array.isArray(report.evidence_rows) ? report.evidence_rows : [];
const consumed = exactlyOne(rows, "consumed");
const boundary = exactlyOne(rows, "turn_boundary_captured");
const provider = exactlyOne(rows, "provider_request_observed");
const completed = exactlyOne(rows, "turn_completed");
const replayRows = Array.isArray(report?.replay_control?.evidence_rows)
  ? report.replay_control.evidence_rows
  : [];
const replayRejected = replayRows.filter(
  (row) =>
    row?.outcome === "ignored" &&
    row?.reason === "replay_already_consumed",
);
const replayInfluence = replayRows.filter((row) =>
  INFLUENCE_OUTCOMES.has(row?.outcome),
);
const reportedRows = [...rows, ...replayRows];
const ledgerRowsForReceipt = ledgerRows.filter(
  (row) => row?.receipt_id === report.receipt_id,
);
const ledgerInfluenceForReceipt = ledgerRowsForReceipt.filter((row) =>
  INFLUENCE_OUTCOMES.has(row?.outcome),
);
const ledgerReplayRejected = ledgerRowsForReceipt.filter(
  (row) =>
    row?.outcome === "ignored" &&
    row?.reason === "replay_already_consumed",
);
const checkpointBytes = Number(report?.ledger_checkpoint?.bytes);
const ledgerCheckpointPrefix =
  Number.isInteger(checkpointBytes) &&
  checkpointBytes >= 0 &&
  checkpointBytes <= ledgerRaw.length
    ? ledgerRaw.subarray(0, checkpointBytes)
    : null;
const canarySha = sha256(report.task_focus_canary ?? "");
const expectedLocalHead = required(args, "expected-local-head");
const expectedMyJevHead = required(args, "expected-my-jev-head");
if (!isGitSha(expectedLocalHead) || !isGitSha(expectedMyJevHead)) {
  throw new Error("Expected Local Studio and my-jev heads must be exact 40-hex Git SHAs");
}

const assertions = {
  report_schema:
    report.schema === "local-studio-system-one-one-turn-acceptance-v2",
  report_heads_are_git_shas:
    isGitSha(report.local_studio_head) && isGitSha(report.my_jev_head),
  expected_local_head_matches:
    report.local_studio_head === expectedLocalHead,
  expected_my_jev_head_matches:
    report.my_jev_head === expectedMyJevHead,
  snapshot_is_sha256: isSha256(report.snapshot_sha256),
  project_fingerprint_is_sha256: isSha256(report.project_fingerprint),
  fixture_raw_hash_matches_report:
    fixtureSha === report.fixture_raw_sha256,
  producer_mode_matches_fixture_model:
    (report.producer_mode === "fixture" && fixture?.model === "recorded/jev") ||
    (report.producer_mode === "harnessrouter-script" && fixture?.model === "script/s1"),
  ledger_checkpoint_shape:
    Number.isInteger(checkpointBytes) &&
    checkpointBytes > 0 &&
    isSha256(report?.ledger_checkpoint?.sha256),
  ledger_checkpoint_prefix_matches:
    ledgerCheckpointPrefix !== null &&
    sha256(ledgerCheckpointPrefix) === report?.ledger_checkpoint?.sha256,
  report_rows_exist_in_durable_ledger:
    rowsAppearInOrder(ledgerRows, reportedRows),
  durable_ledger_has_single_influence_sequence:
    ledgerInfluenceForReceipt.length === 4 &&
    rowsAppearInOrder(ledgerInfluenceForReceipt, rows),
  durable_ledger_has_replay_rejection:
    ledgerReplayRejected.length >= 1,
  consume_marker_hash_matches_report:
    isSha256(report.consume_marker_sha256) &&
    sha256(markerRaw) === report.consume_marker_sha256,
  consume_marker_ids_match:
    marker?.pi_session_id === report.pi_session_id &&
    marker?.receipt_id === report.receipt_id &&
    marker?.response_id === report.response_id,
  consume_marker_response_hash_matches:
    marker?.response_sha256 === fixtureSha,
  consume_marker_receipt_hash_matches:
    marker?.receipt_sha256 === canonicalSha256(profile),
  fixture_response_id_matches: fixture?.id === report.response_id,
  fixture_completed: fixture?.status === "completed",
  fixture_session_matches:
    fixture?.metadata?.session_id === report.uhp_session_id,
  fixture_harness_matches:
    fixture?.metadata?.harness_id === "chrn_system_one",
  fixture_contract_matches: profile?.contract_sha256 === CONTRACT_SHA256,
  fixture_receipt_matches: profile?.receipt_id === report.receipt_id,
  fixture_consumer_is_local_studio:
    profile?.binding?.consumer === "local-studio",
  fixture_pi_session_matches:
    profile?.binding?.consumer_session_id === report.pi_session_id,
  fixture_project_matches:
    profile?.binding?.project_fingerprint === report.project_fingerprint,
  fixture_snapshot_matches:
    profile?.binding?.snapshot_sha256 === report.snapshot_sha256,
  fixture_task_focus_matches:
    profile?.advice?.task_focus === report.task_focus_canary,
  fixture_authority_all_false: allAuthorityFalse(profile?.authority),
  exactly_one_consumed_row: consumed !== null,
  exactly_one_boundary_row: boundary !== null,
  exactly_one_provider_row: provider !== null,
  exactly_one_completed_row: completed !== null,
  consumed_ids_match:
    consumed?.response_id === report.response_id &&
    consumed?.receipt_id === report.receipt_id,
  consumed_raw_hash_matches_fixture:
    consumed?.response_sha256 === fixtureSha,
  consumed_receipt_hash_matches_fixture:
    consumed?.receipt_sha256 === canonicalSha256(profile),
  consumed_contract_matches:
    consumed?.contract_sha256 === CONTRACT_SHA256,
  consumed_harness_matches:
    consumed?.harness_id === "chrn_system_one",
  consumed_binding_matches:
    consumed?.binding?.consumerSessionId === report.pi_session_id &&
    consumed?.binding?.projectFingerprint === report.project_fingerprint &&
    consumed?.binding?.snapshotSha256 === report.snapshot_sha256,
  consumed_authority_all_false:
    allAuthorityFalse(consumed?.authority),
  boundary_model_matches:
    boundary?.selected_model_id === report.model_id,
  boundary_project_matches:
    boundary?.cwd_fingerprint === report.project_fingerprint,
  boundary_tools_are_read_only:
    sameStrings(boundary?.active_tools, READ_ONLY_TOOLS),
  provider_marker_present:
    provider?.advisory_marker_present === true,
  provider_response_id_present:
    provider?.response_id_present === true,
  provider_receipt_id_present:
    provider?.receipt_id_present === true,
  provider_task_focus_present:
    provider?.task_focus_present === true,
  provider_task_focus_hash_matches:
    provider?.task_focus_sha256 === canarySha,
  provider_model_matches_expected:
    provider?.provider_model_matches_expected === true,
  provider_model_equality_recomputed:
    provider?.provider_model === provider?.expected_backend_model_id &&
    provider?.expected_backend_model_id === boundary?.backend_model_id,
  provider_tools_match_active:
    provider?.provider_tools_match_active === true,
  provider_tools_equality_recomputed:
    sameStrings(provider?.provider_tools, boundary?.active_tools) &&
    sameStrings(provider?.active_tools, boundary?.active_tools),
  provider_request_hash_present:
    isSha256(provider?.provider_request_sha256),
  completed_provider_request_count_one:
    completed?.provider_request_count === 1,
  completed_no_tool_calls:
    completed?.tool_call_count === 0,
  completed_task_focus_observed:
    completed?.task_focus_observed_in_agent_messages === true,
  completed_task_focus_echo_exact:
    completed?.task_focus_echo_exact === true,
  completed_assistant_hash_matches_canary:
    completed?.assistant_text_sha256 === canarySha,
  completed_model_unchanged:
    completed?.selected_model_unchanged === true,
  completed_model_equality_recomputed:
    completed?.selected_model_id_before === boundary?.selected_model_id &&
    completed?.selected_model_id_after === boundary?.selected_model_id,
  completed_route_unchanged:
    completed?.provider_route_unchanged === true,
  completed_route_equality_recomputed:
    completed?.provider_id_before === boundary?.provider_id &&
    completed?.provider_id_after === boundary?.provider_id &&
    completed?.backend_model_id_before === boundary?.backend_model_id &&
    completed?.backend_model_id_after === boundary?.backend_model_id,
  completed_cwd_unchanged:
    completed?.cwd_unchanged === true,
  completed_cwd_equality_recomputed:
    completed?.cwd_fingerprint_before === boundary?.cwd_fingerprint &&
    completed?.cwd_fingerprint_after === boundary?.cwd_fingerprint,
  completed_tools_equality_recomputed:
    sameStrings(completed?.active_tools_at_injection, boundary?.active_tools) &&
    completed?.active_tools_sha256 === canonicalSha256(
      [...new Set(boundary?.active_tools ?? [])].sort(),
    ),
  completed_authority_all_false:
    allAuthorityFalse(completed?.authority),
  runtime_before_model_matches:
    report?.status_before?.modelId === report.model_id,
  runtime_after_model_matches:
    report?.status_after?.modelId === report.model_id,
  runtime_before_cwd_matches:
    report?.status_before?.cwd === report.project_cwd,
  runtime_after_cwd_matches:
    report?.status_after?.cwd === report.project_cwd,
  runtime_before_pi_session_matches:
    report?.status_before?.piSessionId === report.pi_session_id,
  runtime_after_pi_session_matches:
    report?.status_after?.piSessionId === report.pi_session_id,
  replay_rejected_exactly_once:
    replayRejected.length === 1,
  replay_has_no_influence_rows:
    replayInfluence.length === 0,
  replay_model_unchanged:
    report?.replay_control?.status_before?.modelId === report.model_id &&
    report?.replay_control?.status_after?.modelId === report.model_id,
  replay_cwd_unchanged:
    report?.replay_control?.status_before?.cwd === report.project_cwd &&
    report?.replay_control?.status_after?.cwd === report.project_cwd,
  replay_pi_session_unchanged:
    report?.replay_control?.status_before?.piSessionId === report.pi_session_id &&
    report?.replay_control?.status_after?.piSessionId === report.pi_session_id,
};

const producer = verifyProducer(
  report,
  systemOneDir,
  fixtureSha,
);
Object.assign(assertions, producer.assertions);

const independentlyPasses = Object.values(assertions).every(Boolean);
assertions.reported_verdict_matches_recomputed =
  report.verdict === (independentlyPasses ? "pass" : "fail");
const verdict = Object.values(assertions).every(Boolean) ? "pass" : "fail";

const result = {
  schema: "local-studio-system-one-offline-evidence-verification-v1",
  verdict,
  acceptance_report: reportPath,
  acceptance_report_sha256: sha256File(reportPath),
  system_one_dir: systemOneDir,
  fixture_path: fixturePath,
  fixture_raw_sha256: fixtureSha,
  consume_marker_path: markerPath,
  consume_marker_sha256: sha256(markerRaw),
  ledger_path: ledgerPath,
  ledger_checkpoint: report.ledger_checkpoint,
  local_studio_head: report.local_studio_head,
  my_jev_head: report.my_jev_head,
  producer_mode: report.producer_mode,
  response_id: report.response_id,
  receipt_id: report.receipt_id,
  pi_session_id: report.pi_session_id,
  snapshot_sha256: report.snapshot_sha256,
  project_fingerprint: report.project_fingerprint,
  producer: producer.files,
  assertions,
};

const output = args.get("output") ? resolve(args.get("output")) : null;
if (output) {
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n", "utf8");
}
process.stdout.write(
  JSON.stringify({ ...result, output }, null, 2) + "\n",
);
if (verdict !== "pass") process.exitCode = 1;
