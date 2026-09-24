#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_PROVENANCE_FILES = [
  "services/agent-runtime/src/runtime-provenance.ts",
  "services/agent-runtime/src/system-one-advisory.ts",
  "services/agent-runtime/src/pi-runtime.ts",
  "services/agent-runtime/src/pi-runtime-types.ts",
  "services/agent-runtime/src/http/handlers.ts",
  "services/agent-runtime/src/server.ts",
  "services/agent-runtime/package.json",
  "services/agent-runtime/bun.lock",
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

function required(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitHead(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function requireCleanGitCheckout(cwd, label) {
  const head = gitHead(cwd);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`${label} checkout has no exact Git HEAD`);
  }
  const status = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd, encoding: "utf8" },
  );
  if (status.status !== 0) {
    throw new Error(
      `${label} git status failed: ${status.stderr || status.stdout}`,
    );
  }
  if (status.stdout.trim()) {
    throw new Error(
      `${label} checkout must be clean for exact-head evidence:\n${status.stdout}`,
    );
  }
  return head;
}

function readLedger(filepath) {
  if (!existsSync(filepath)) return [];
  return readFileSync(filepath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function canonicalProjectFingerprint(cwd) {
  const canonical = realpathSync(cwd).replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return sha256(canonical);
}

function consumeMarkerPath(systemOneDir, piSessionId, receiptId) {
  const key = sha256(`${piSessionId}\0${receiptId}`);
  return join(systemOneDir, "consumed", `${key}.json`);
}

function allAuthorityFalse(value) {
  if (!value || typeof value !== "object") return false;
  const keys = [
    "dispatch_allowed",
    "approval_granted",
    "claim_acquired",
    "mutation_allowed",
    "routing_authority_changed",
  ];
  return keys.every((key) => value[key] === false);
}

function sameStrings(left, right) {
  const a = [...new Set(left ?? [])].sort();
  const b = [...new Set(right ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function runtimeStatus(baseUrl, sessionId) {
  const url = new URL("/api/agent/runtime/status", baseUrl);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("after", "0");
  return requestJson(url);
}

async function sendTurn(baseUrl, body) {
  return requestJson(new URL("/api/agent/turn", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForIdle(baseUrl, sessionId, minEventSeq, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await runtimeStatus(baseUrl, sessionId);
    const status = latest?.status;
    if (
      status &&
      status.active === false &&
      Number(status.eventSeq ?? 0) > Number(minEventSeq ?? -1)
    ) {
      return latest;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for runtime session '${sessionId}' to settle; last status=${JSON.stringify(latest?.status ?? null)}`,
  );
}

function parseProducerEvidence(stderr) {
  const candidates = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(candidates[index]);
    } catch {}
  }
  return null;
}

function snapshotStatus(status) {
  if (!status) return null;
  return {
    active: status.active,
    running: status.running,
    modelId: status.modelId,
    cwd: status.cwd,
    piSessionId: status.piSessionId,
    eventSeq: status.eventSeq,
    lastError: status.lastError,
  };
}

function validateRuntimeProvenance(provenance, expectedHead, repoRoot) {
  if (!provenance || typeof provenance !== "object") {
    throw new Error("Agent runtime did not expose startup provenance");
  }
  if (provenance.schema !== "local-studio-agent-runtime-provenance-v1") {
    throw new Error(`Unexpected agent-runtime provenance schema: ${provenance.schema ?? "null"}`);
  }
  if (provenance.git_head !== expectedHead) {
    throw new Error(
      `Running agent-runtime head drift: expected ${expectedHead}, got ${provenance.git_head ?? "null"}`,
    );
  }
  if (provenance.source_clean !== true) {
    throw new Error("Running agent-runtime was built/started from a dirty source tree");
  }
  if (!["built", "source"].includes(provenance.mode)) {
    throw new Error(`Agent-runtime provenance is unverified: ${provenance.mode ?? "null"}`);
  }
  if (!/^[0-9a-f]{64}$/.test(provenance.manifest_sha256 ?? "")) {
    throw new Error("Agent-runtime provenance manifest hash is missing or invalid");
  }
  if (!provenance.files || typeof provenance.files !== "object") {
    throw new Error("Agent-runtime provenance has no critical source hashes");
  }
  for (const relativePath of RUNTIME_PROVENANCE_FILES) {
    const expected = sha256(readFileSync(join(repoRoot, relativePath)));
    const observed = provenance.files[relativePath];
    if (observed !== expected) {
      throw new Error(
        `Running agent-runtime source drift for ${relativePath}: expected ${expected}, got ${observed ?? "null"}`,
      );
    }
  }
  return provenance;
}

function sameRuntimeProvenance(left, right) {
  return (
    left?.schema === right?.schema &&
    left?.git_head === right?.git_head &&
    left?.source_clean === right?.source_clean &&
    left?.mode === right?.mode &&
    left?.started_at === right?.started_at &&
    left?.manifest_sha256 === right?.manifest_sha256 &&
    JSON.stringify(left?.files ?? null) === JSON.stringify(right?.files ?? null)
  );
}

const args = parseArgs(process.argv.slice(2));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const localStudioRoot = resolve(scriptDir, "..");
const baseUrl = new URL(args.get("base-url") ?? "http://127.0.0.1:8081");
const runtimeSessionId =
  args.get("runtime-session-id") ?? `uhp-one-turn-${process.pid}-${Date.now()}`;
const modelId = required(args, "model");
const projectCwd = realpathSync(required(args, "cwd"));
const dataDir = resolve(required(args, "data-dir"));
const myJevRepo = realpathSync(required(args, "my-jev-repo"));
const snapshotSha256 = required(args, "snapshot-sha256");
const python = args.get("python") ?? "python3";
const workId = args.get("work-id") ?? "acceptance-local-studio-pr3";
const timeoutMs = Number(args.get("timeout-ms") ?? 180000);
const producerMode = args.get("producer") ?? "fixture";
const snapshotPath = args.get("snapshot") ? realpathSync(args.get("snapshot")) : null;
const harnessrouterRepo = args.get("harnessrouter-repo")
  ? realpathSync(args.get("harnessrouter-repo"))
  : null;
const harnessrouterPython = args.get("harnessrouter-python") ?? python;
const localStudioHeadBefore = requireCleanGitCheckout(
  localStudioRoot,
  "Local Studio",
);
const myJevHeadBefore = requireCleanGitCheckout(myJevRepo, "my-jev");

if (!["fixture", "harnessrouter-script"].includes(producerMode)) {
  throw new Error("--producer must be fixture or harnessrouter-script");
}
if (producerMode === "harnessrouter-script" && (!snapshotPath || !harnessrouterRepo)) {
  throw new Error(
    "--producer harnessrouter-script requires --snapshot and --harnessrouter-repo",
  );
}

if (!/^[0-9a-f]{64}$/.test(snapshotSha256)) {
  throw new Error("--snapshot-sha256 must be exactly 64 lowercase hex characters");
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout-ms must be a positive number");
}

const systemOneDir = join(dataDir, "system-one");
const ledgerPath = join(systemOneDir, "consumption.jsonl");
const latestPath = join(systemOneDir, "latest.json");
mkdirSync(join(systemOneDir, "sessions"), { recursive: true });
mkdirSync(join(systemOneDir, "acceptance"), { recursive: true });

if (existsSync(latestPath)) {
  throw new Error(
    `Refusing acceptance with ${latestPath} present; use an isolated LOCAL_STUDIO_DATA_DIR so the bootstrap turn cannot consume unrelated advice.`,
  );
}

const beforeBootstrapLedger = readLedger(ledgerPath);
let initial = await runtimeStatus(baseUrl, runtimeSessionId);
const runtimeProvenance = validateRuntimeProvenance(
  initial?.runtimeProvenance,
  localStudioHeadBefore,
  localStudioRoot,
);
let piSessionId = initial?.status?.piSessionId ?? null;

if (!piSessionId) {
  const bootstrap = await sendTurn(baseUrl, {
    mode: "prompt",
    sessionId: runtimeSessionId,
    modelId,
    cwd: projectCwd,
    piSessionId: null,
    toolAccess: "read_only",
    message: "Reply exactly BOOTSTRAP_READY. Do not use tools.",
  });
  const bootstrapSeq = Number(bootstrap?.status?.eventSeq ?? initial?.status?.eventSeq ?? -1);
  initial = await waitForIdle(baseUrl, runtimeSessionId, bootstrapSeq - 1, timeoutMs);
  if (!sameRuntimeProvenance(runtimeProvenance, initial?.runtimeProvenance)) {
    throw new Error("Agent-runtime provenance changed during bootstrap");
  }
  piSessionId = initial?.status?.piSessionId ?? bootstrap?.piSessionId ?? null;
}

if (!piSessionId) {
  throw new Error("Runtime did not expose a canonical Pi session id after bootstrap");
}
if (initial.status?.active) {
  throw new Error("Acceptance requires an idle runtime session");
}
if (initial.status?.modelId !== modelId) {
  throw new Error(
    `Bootstrap model drift: expected '${modelId}', got '${initial.status?.modelId ?? "null"}'`,
  );
}
if (realpathSync(initial.status.cwd) !== projectCwd) {
  throw new Error(
    `Bootstrap cwd drift: expected '${projectCwd}', got '${initial.status?.cwd ?? "null"}'`,
  );
}

const bootstrapLedger = readLedger(ledgerPath).slice(beforeBootstrapLedger.length);
if (bootstrapLedger.length > 0) {
  throw new Error(
    `Bootstrap unexpectedly produced System-One ledger entries; acceptance data dir is not isolated: ${JSON.stringify(bootstrapLedger)}`,
  );
}

const nonce = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
const responseId = `resp_one_turn_${nonce}_${process.pid}`;
const receiptId = `one-turn-${nonce}-${process.pid}`;
const uhpSessionId = `hsess-one-turn-${nonce}`;
const canary = `UHP_ONE_TURN_${randomBytes(16).toString("hex")}`;
const fixturePath = join(systemOneDir, "sessions", `${piSessionId}.json`);

if (existsSync(fixturePath)) {
  throw new Error(
    `Refusing to overwrite existing session advisory fixture: ${fixturePath}. Use a fresh runtime session/data directory.`,
  );
}

const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
let producer;
let producerEvidence;
let expectedProducerModel;

if (producerMode === "fixture") {
  const producerArgs = [
    "-m",
    "my_jev.uhp_fixture",
    "--decision",
    "examples/uhp/decision.json",
    "--fleet-resolution",
    "examples/uhp/fleet-resolution.json",
    "--fleet-handle-map",
    "examples/uhp/fleet-handles.json",
    "--provenance",
    "examples/uhp/provenance.json",
    "--receipt-id",
    receiptId,
    "--response-id",
    responseId,
    "--session-id",
    uhpSessionId,
    "--harness-id",
    "chrn_system_one",
    "--model",
    "recorded/jev",
    "--work-id",
    workId,
    "--consumer-session-id",
    piSessionId,
    "--project-cwd",
    projectCwd,
    "--snapshot-sha256",
    snapshotSha256,
    "--observed-at",
    now,
    "--created-at",
    now,
    "--ttl-seconds",
    "600",
    "--task-focus",
    canary,
    "--context-priority",
    "current-pr",
    "--context-priority",
    "latest-handoff",
    "--output",
    fixturePath,
  ];
  producer = spawnSync(python, producerArgs, {
    cwd: myJevRepo,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [
        join(myJevRepo, "src"),
        process.env.PYTHONPATH ?? "",
      ]
        .filter(Boolean)
        .join(process.platform === "win32" ? ";" : ":"),
    },
  });
  if (producer.status !== 0) {
    throw new Error(
      `my-jev fixture generation failed (exit ${producer.status}):\n${producer.stderr || producer.stdout}`,
    );
  }
  producerEvidence = parseProducerEvidence(producer.stderr);
  expectedProducerModel = "recorded/jev";
} else {
  const producerDir = join(systemOneDir, "producer", responseId);
  const producerArgs = [
    "-m",
    "my_jev.harnessrouter_probe",
    "--harnessrouter-repo",
    harnessrouterRepo,
    "--harnessrouter-python",
    harnessrouterPython,
    "--snapshot",
    snapshotPath,
    "--output-dir",
    producerDir,
    "--consumer-session-id",
    piSessionId,
    "--project-cwd",
    projectCwd,
    "--receipt-id",
    receiptId,
    "--response-id",
    responseId,
    "--uhp-session-id",
    uhpSessionId,
    "--harness-id",
    "chrn_system_one",
    "--ttl-seconds",
    "600",
    "--task-focus",
    canary,
  ];
  producer = spawnSync(python, producerArgs, {
    cwd: myJevRepo,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [
        join(myJevRepo, "src"),
        process.env.PYTHONPATH ?? "",
      ]
        .filter(Boolean)
        .join(process.platform === "win32" ? ";" : ":"),
    },
  });
  if (producer.status !== 0) {
    throw new Error(
      `my-jev HarnessRouter probe failed (exit ${producer.status}):\n${producer.stderr || producer.stdout}`,
    );
  }
  producerEvidence = parseProducerEvidence(producer.stdout);
  if (producerEvidence?.verdict !== "pass") {
    throw new Error(
      `HarnessRouter producer evidence did not pass: ${JSON.stringify(producerEvidence)}`,
    );
  }
  if (producerEvidence?.snapshot_sha256 !== snapshotSha256) {
    throw new Error(
      `HarnessRouter producer snapshot mismatch: expected ${snapshotSha256}, got ${producerEvidence?.snapshot_sha256 ?? "null"}`,
    );
  }
  const producedResponse = producerEvidence?.stored_response;
  if (!producedResponse || !existsSync(producedResponse)) {
    throw new Error("HarnessRouter producer did not expose its stored UHP response");
  }
  copyFileSync(producedResponse, fixturePath);
  expectedProducerModel = "script/s1";
}

const fixtureRaw = readFileSync(fixturePath, "utf8");
const fixtureRawSha256 = sha256(fixtureRaw);
const ledgerStart = readLedger(ledgerPath).length;
const before = await runtimeStatus(baseUrl, runtimeSessionId);
const beforeStatus = before.status;
if (!beforeStatus || beforeStatus.active) {
  throw new Error("Acceptance turn requires an idle initialized runtime");
}

const command = await sendTurn(baseUrl, {
  mode: "prompt",
  sessionId: runtimeSessionId,
  modelId,
  cwd: projectCwd,
  piSessionId,
  toolAccess: "read_only",
  message:
    "Do not use any tools. Reply with exactly the task_focus value from the Local Studio System-One advisory and nothing else.",
});

const after = await waitForIdle(
  baseUrl,
  runtimeSessionId,
  Number(beforeStatus.eventSeq ?? -1),
  timeoutMs,
);
const afterStatus = after.status;
if (!sameRuntimeProvenance(runtimeProvenance, before?.runtimeProvenance)) {
  throw new Error("Agent-runtime provenance changed before the acceptance turn");
}
if (!sameRuntimeProvenance(runtimeProvenance, after?.runtimeProvenance)) {
  throw new Error("Agent-runtime provenance changed during the acceptance turn");
}
const evidenceRows = readLedger(ledgerPath)
  .slice(ledgerStart)
  .filter((row) => row.response_id === responseId);

const byOutcome = new Map();
for (const row of evidenceRows) {
  const bucket = byOutcome.get(row.outcome) ?? [];
  bucket.push(row);
  byOutcome.set(row.outcome, bucket);
}

const consumed = byOutcome.get("consumed")?.at(-1) ?? null;
const boundary = byOutcome.get("turn_boundary_captured")?.at(-1) ?? null;
const providerRows = byOutcome.get("provider_request_observed") ?? [];
const provider = providerRows.at(-1) ?? null;
const completed = byOutcome.get("turn_completed")?.at(-1) ?? null;
const expectedTools = ["find", "grep", "ls", "read"];
const expectedCwdFingerprint = canonicalProjectFingerprint(projectCwd);

const assertions = {
  fixture_response_id: consumed?.response_id === responseId,
  fixture_receipt_id: consumed?.receipt_id === receiptId,
  raw_fixture_hash_matches_ledger: consumed?.response_sha256 === fixtureRawSha256,
  consumed_authority_all_false: allAuthorityFalse(consumed?.authority),
  boundary_model_unchanged_from_requested: boundary?.selected_model_id === modelId,
  boundary_cwd_matches_project:
    boundary?.cwd_fingerprint === expectedCwdFingerprint,
  boundary_tools_are_read_only:
    sameStrings(boundary?.active_tools, expectedTools),
  provider_request_count_is_one: completed?.provider_request_count === 1,
  provider_marker_present: provider?.advisory_marker_present === true,
  provider_response_id_present: provider?.response_id_present === true,
  provider_receipt_id_present: provider?.receipt_id_present === true,
  provider_task_focus_present: provider?.task_focus_present === true,
  provider_task_focus_hash_matches:
    provider?.task_focus_sha256 === sha256(canary),
  provider_model_matches_expected: provider?.provider_model_matches_expected === true,
  provider_tools_match_active: provider?.provider_tools_match_active === true,
  no_tool_calls: completed?.tool_call_count === 0,
  task_focus_reached_agent_messages:
    completed?.task_focus_observed_in_agent_messages === true,
  task_focus_echo_exact: completed?.task_focus_echo_exact === true,
  assistant_text_hash_matches_canary:
    completed?.assistant_text_sha256 === sha256(canary),
  selected_model_unchanged: completed?.selected_model_unchanged === true,
  provider_route_unchanged: completed?.provider_route_unchanged === true,
  cwd_unchanged: completed?.cwd_unchanged === true,
  completion_authority_all_false: allAuthorityFalse(completed?.authority),
  runtime_model_unchanged:
    beforeStatus.modelId === modelId && afterStatus?.modelId === modelId,
  runtime_cwd_unchanged:
    realpathSync(beforeStatus.cwd) === projectCwd &&
    realpathSync(afterStatus.cwd) === projectCwd,
  runtime_pi_session_unchanged:
    beforeStatus.piSessionId === piSessionId &&
    afterStatus.piSessionId === piSessionId,
  runtime_provenance_exact_head:
    runtimeProvenance.git_head === localStudioHeadBefore,
  runtime_provenance_clean: runtimeProvenance.source_clean === true,
  runtime_provenance_verified_mode:
    runtimeProvenance.mode === "built" || runtimeProvenance.mode === "source",
  producer_model_is_not_coding_model:
    consumed?.served_model === expectedProducerModel && consumed?.served_model !== modelId,
  producer_raw_response_matches_fixture:
    producerMode !== "harnessrouter-script" ||
    producerEvidence?.stored_response_raw_sha256 === fixtureRawSha256,
  contract_hash_matches_expected:
    consumed?.contract_sha256 ===
    "5e88c73e7cbb2e46f3b5171951d2a84f0549633fbcb420458d56ae5ada0ffc8f",
  harness_is_expected_system_one:
    consumed?.harness_id === "chrn_system_one",
  binding_session_matches:
    consumed?.binding?.consumerSessionId === piSessionId,
  binding_project_matches:
    consumed?.binding?.projectFingerprint === expectedCwdFingerprint,
  binding_snapshot_matches:
    consumed?.binding?.snapshotSha256 === snapshotSha256,
};

// Re-present the exact same receipt for one control turn. The coding model may
// still answer the user, but the System-One receipt must not be injected again.
const replayLedgerStart = readLedger(ledgerPath).length;
const replayBefore = await runtimeStatus(baseUrl, runtimeSessionId);
const replayCommand = await sendTurn(baseUrl, {
  mode: "prompt",
  sessionId: runtimeSessionId,
  modelId,
  cwd: projectCwd,
  piSessionId,
  toolAccess: "read_only",
  message: "Reply exactly REPLAY_CONTROL_OK. Do not use tools.",
});
const replayAfter = await waitForIdle(
  baseUrl,
  runtimeSessionId,
  Number(replayBefore?.status?.eventSeq ?? -1),
  timeoutMs,
);
if (!sameRuntimeProvenance(runtimeProvenance, replayBefore?.runtimeProvenance)) {
  throw new Error("Agent-runtime provenance changed before replay control");
}
if (!sameRuntimeProvenance(runtimeProvenance, replayAfter?.runtimeProvenance)) {
  throw new Error("Agent-runtime provenance changed during replay control");
}
const replayRows = readLedger(ledgerPath).slice(replayLedgerStart);
const replayForReceipt = replayRows.filter((row) => row.receipt_id === receiptId);
const replayIgnored = replayForReceipt.find(
  (row) => row.outcome === "ignored" && row.reason === "replay_already_consumed",
);
const replayInfluenceRows = replayForReceipt.filter((row) =>
  ["consumed", "turn_boundary_captured", "provider_request_observed", "turn_completed"].includes(
    row.outcome,
  ),
);

Object.assign(assertions, {
  replay_is_rejected: Boolean(replayIgnored),
  replay_has_no_advisory_influence_rows: replayInfluenceRows.length === 0,
  replay_runtime_model_unchanged:
    replayBefore?.status?.modelId === modelId && replayAfter?.status?.modelId === modelId,
  replay_runtime_cwd_unchanged:
    realpathSync(replayBefore?.status?.cwd) === projectCwd &&
    realpathSync(replayAfter?.status?.cwd) === projectCwd,
  replay_pi_session_unchanged:
    replayBefore?.status?.piSessionId === piSessionId &&
    replayAfter?.status?.piSessionId === piSessionId,
});

const markerPath = consumeMarkerPath(systemOneDir, piSessionId, receiptId);
if (!existsSync(markerPath)) {
  throw new Error(`Expected durable consume marker is missing: ${markerPath}`);
}
const markerRaw = readFileSync(markerPath);
const ledgerRaw = existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.alloc(0);
if (ledgerRaw.length === 0) {
  throw new Error("System-One consumption ledger is empty after acceptance");
}

const localStudioHeadAfter = requireCleanGitCheckout(
  localStudioRoot,
  "Local Studio",
);
const myJevHeadAfter = requireCleanGitCheckout(myJevRepo, "my-jev");
if (
  localStudioHeadAfter !== localStudioHeadBefore ||
  myJevHeadAfter !== myJevHeadBefore
) {
  throw new Error(
    "Source checkout HEAD changed during the System-One acceptance transaction",
  );
}

const verdict = Object.values(assertions).every(Boolean) ? "pass" : "fail";
const report = {
  schema: "local-studio-system-one-one-turn-acceptance-v2",
  verdict,
  generated_at: new Date().toISOString(),
  local_studio_head: localStudioHeadBefore,
  my_jev_head: myJevHeadBefore,
  runtime_provenance: runtimeProvenance,
  runtime_provenance_sha256: sha256(JSON.stringify(runtimeProvenance)),
  source_checkouts_clean: true,
  source_heads_stable: true,
  producer_mode: producerMode,
  base_url: baseUrl.toString(),
  runtime_session_id: runtimeSessionId,
  pi_session_id: piSessionId,
  model_id: modelId,
  project_cwd: projectCwd,
  project_fingerprint: expectedCwdFingerprint,
  snapshot_sha256: snapshotSha256,
  response_id: responseId,
  receipt_id: receiptId,
  uhp_session_id: uhpSessionId,
  task_focus_canary: canary,
  fixture_path: fixturePath,
  fixture_raw_sha256: fixtureRawSha256,
  consume_marker_sha256: sha256(markerRaw),
  ledger_checkpoint: {
    bytes: ledgerRaw.length,
    sha256: sha256(ledgerRaw),
  },
  producer_evidence: producerEvidence,
  profile_hash_cross_language_comparison_deferred: true,
  command_outcome: command?.outcome ?? null,
  status_before: snapshotStatus(beforeStatus),
  status_after: snapshotStatus(afterStatus),
  replay_control: {
    command_outcome: replayCommand?.outcome ?? null,
    status_before: snapshotStatus(replayBefore?.status),
    status_after: snapshotStatus(replayAfter?.status),
    evidence_rows: replayForReceipt,
  },
  assertions,
  evidence_rows: evidenceRows,
};

const reportPath = join(systemOneDir, "acceptance", `${responseId}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");

if (verdict !== "pass") process.exitCode = 1;
