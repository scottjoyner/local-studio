#!/usr/bin/env node
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const allowedOptions = new Set(["--help", "--evidence", "--output-dir", "--source-url"]);
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!argument.startsWith("--")) continue;
  if (!allowedOptions.has(argument)) {
    throw new Error(`unknown option: ${argument}`);
  }
  if (argument !== "--help") index += 1;
}

const value = (name, fallback = null) => {
  const index = argv.lastIndexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

if (argv.includes("--help")) {
  process.stdout.write(
    [
      "Usage: node scripts/render-r9700-bonsai-registry-candidate.mjs --evidence <path> [options]",
      "  --output-dir <directory>",
      "  --source-url <url>",
      "",
      "The renderer refuses evidence unless summary.candidatePromotable is true.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const evidencePath = value("--evidence");
if (!evidencePath) throw new Error("--evidence is required");

const sourceUrl = value(
  "--source-url",
  "https://github.com/scottjoyner/local-studio/pull/1",
);
const hardwareId = "radeon-ai-pro-r9700-32gb";
const modelInstanceId = "prism-ml-ternary-bonsai-2-27b-gguf--pq2-0";
const recipeId = "llamacpp-bonsai2-pq2-radeon-ai-pro-r9700-32gb-tp1";
const outputDir = resolve(value("--output-dir", "registry-handoff"));

const raw = readFileSync(resolve(evidencePath));
const evidenceSha256 = createHash("sha256").update(raw).digest("hex");
const evidence = JSON.parse(raw.toString("utf8"));

if (evidence?.schemaVersion !== "local-studio/local-ai-evidence/v1") {
  throw new Error(
    `unsupported evidence schema: ${String(evidence?.schemaVersion ?? "missing")}`,
  );
}
if (evidence?.summary?.candidatePromotable !== true) {
  throw new Error("evidence is not promotable; refusing to render a registry candidate");
}

const expected = {
  hardwareArch: "gfx1201",
  gpuName: "Radeon AI PRO R9700",
  modelRevision: "6ed5e12bf84b7a63069882c91dd9e9218647d17b",
  model: "Ternary-Bonsai-2-27B-PQ2_0",
  recipe: "bonsai2-r9700-prism-rocm",
  engineCommit: "9a9394a895b96003ca842a6041cb28ac49a108f7",
  modelSha256: "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
  projectorSha256: "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903",
};

const assertEqual = (actual, wanted, label) => {
  if (actual !== wanted) {
    throw new Error(`${label} mismatch: expected ${wanted}, got ${String(actual)}`);
  }
};

assertEqual(evidence?.hardware?.requiredArch, expected.hardwareArch, "hardware arch");
assertEqual(evidence?.hardware?.requiredGpuName, expected.gpuName, "GPU identity");
assertEqual(evidence?.target?.modelRevision, expected.modelRevision, "model revision");
assertEqual(evidence?.target?.model, expected.model, "served model");
assertEqual(evidence?.target?.recipeId, expected.recipe, "recipe id");
if (!String(evidence?.target?.engineRef ?? "").endsWith(`@${expected.engineCommit}`)) {
  throw new Error("engine ref is not pinned to the accepted PrismML commit");
}

const requiredSummaryFlags = [
  "hardwareArchitectureAccepted",
  "hardwareIdentityAccepted",
  "controllerAccepted",
  "compatibilityAccepted",
  "endpointModelsAccepted",
  "modelAdvertised",
  "completionAccepted",
  "toolProbeRequested",
  "toolCallAccepted",
  "sourceCheckoutAccepted",
  "artifactProvenanceAccepted",
  "sessionEvidenceAccepted",
  "benchmarkEvidenceAccepted",
];
for (const flag of requiredSummaryFlags) {
  if (evidence?.summary?.[flag] !== true) {
    throw new Error(`accepted evidence is inconsistent: summary.${flag} is not true`);
  }
}

const rawArchitectures = Array.isArray(evidence?.hardware?.architectures)
  ? evidence.hardware.architectures.map((entry) => String(entry).toLowerCase())
  : [];
if (!rawArchitectures.includes(expected.hardwareArch)) {
  throw new Error("raw ROCm architecture evidence does not contain gfx1201");
}

const controllerGpus =
  evidence?.controller?.gpus?.body &&
  typeof evidence.controller.gpus.body === "object" &&
  Array.isArray(evidence.controller.gpus.body.gpus)
    ? evidence.controller.gpus.body.gpus
    : [];
const rawMatchingGpu = controllerGpus.find(
  (gpu) =>
    gpu &&
    typeof gpu === "object" &&
    typeof gpu.name === "string" &&
    gpu.name.toLowerCase().includes(expected.gpuName.toLowerCase()),
);
if (!rawMatchingGpu) {
  throw new Error("controller GPU evidence does not contain Radeon AI PRO R9700");
}
if (evidence?.controller?.status?.ok !== true) {
  throw new Error("controller status evidence is not accepted");
}
const compatibility = evidence?.controller?.compatibility;
if (
  compatibility?.ok !== true ||
  (Array.isArray(compatibility?.body?.checks) &&
    compatibility.body.checks.some(
      (check) => check && typeof check === "object" && check.severity === "error",
    ))
) {
  throw new Error("controller compatibility evidence contains an error");
}

if (
  evidence?.endpoint?.models?.ok !== true ||
  evidence?.endpoint?.modelAdvertised !== true ||
  !Array.isArray(evidence?.endpoint?.advertisedModelIds) ||
  !evidence.endpoint.advertisedModelIds.includes(expected.model)
) {
  throw new Error("raw model discovery evidence does not advertise the accepted model");
}
if (evidence?.endpoint?.completion?.accepted !== true) {
  throw new Error("raw completion evidence is not accepted");
}
if (
  evidence?.endpoint?.toolCall?.accepted !== true ||
  evidence?.endpoint?.toolCall?.matchedFunction !== "report_acceptance" ||
  evidence?.endpoint?.toolCall?.arguments?.token !== "LOCAL_AI_TOOL_ACCEPTED"
) {
  throw new Error("raw structured tool-call evidence is not accepted");
}
if (
  evidence?.source?.trackedCheckoutStatus?.status !== 0 ||
  evidence?.source?.trackedCheckoutStatus?.stdout !== ""
) {
  throw new Error("Local Studio tracked checkout is not clean");
}

const sha256Pattern = /^[0-9a-f]{64}$/i;
const validFileReceipt = (entry) =>
  entry &&
  entry.type === "file" &&
  sha256Pattern.test(String(entry.sha256 ?? "")) &&
  Number.isFinite(Number(entry.sizeBytes)) &&
  Number(entry.sizeBytes) > 0;

for (const [label, entry] of [
  ["model", evidence?.target?.modelFile],
  ["projector", evidence?.target?.projectorFile],
  ["engine", evidence?.target?.engineFile],
]) {
  if (!validFileReceipt(entry)) {
    throw new Error(`${label} artifact is not a positive-size file with a SHA-256 receipt`);
  }
}
assertEqual(
  String(evidence.target.modelFile.sha256).toLowerCase(),
  expected.modelSha256,
  "Bonsai 2 PQ2 artifact SHA-256",
);
assertEqual(
  String(evidence.target.projectorFile.sha256).toLowerCase(),
  expected.projectorSha256,
  "Bonsai 2 projector SHA-256",
);

const capturedAt = evidence.capturedAt;
if (typeof capturedAt !== "string" || !capturedAt) {
  throw new Error("evidence capturedAt is missing");
}
const sourceRevision = evidence?.summary?.localStudioRevision ?? evidence?.source?.localStudioRevision;
if (typeof sourceRevision !== "string" || !/^[0-9a-f]{40}$/i.test(sourceRevision)) {
  throw new Error("Local Studio source revision is not an exact Git SHA");
}
const normalizedSourceRevision = sourceRevision.toLowerCase();

const evidenceSource = {
  captured_at: capturedAt,
  kind: "local-studio-evidence",
  url: sourceUrl,
  repository: "https://github.com/scottjoyner/local-studio",
  commit: normalizedSourceRevision,
};

const fact = (reason) => ({
  state: "known",
  reason,
  provenance: {
    captured_at: capturedAt,
    sources: [evidenceSource],
  },
});

const safeFileReceipt = (entry) => ({
  name: basename(entry.reference ?? ""),
  size_bytes: entry.sizeBytes ?? null,
  sha256: entry.sha256,
});

const acceptedSessions = (evidence.sessions ?? [])
  .filter(
    (entry) =>
      ["opencode", "hermes"].includes(entry?.agent) &&
      validFileReceipt(entry),
  )
  .map((entry) => ({
    agent: entry.agent,
    artifact: safeFileReceipt(entry),
  }));

if (acceptedSessions.length === 0) {
  throw new Error("promotable evidence unexpectedly has no file-backed OpenCode/Hermes session");
}

const modelFile = evidence.target.modelFile;
const projectorFile = evidence.target.projectorFile;
const engineFile = evidence.target.engineFile;
const modelSizeGb = Math.round((Number(modelFile.sizeBytes) / 1e9) * 1000) / 1000;

const modelInstance = {
  schema_version: "local-ai-registry/v1",
  id: modelInstanceId,
  kind: "quant",
  model_id: "bonsai-27b",
  repository: "prism-ml/Ternary-Bonsai-2-27B-gguf",
  revision: expected.modelRevision,
  served_name: expected.model,
  url: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf",
  huggingface: {
    link_type: "repository",
    status: "known",
    reason: "exact-repository-and-revision-from-local-studio-acceptance",
    repository: "prism-ml/Ternary-Bonsai-2-27B-gguf",
    url: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf",
    provenance: {
      captured_at: capturedAt,
      sources: [evidenceSource],
    },
  },
  weights: {
    artifact: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
    format: "GGUF",
    precision: "PQ2_0",
    publication_id: null,
    size_gb: modelSizeGb,
    source: "local-studio-evidence",
  },
  provenance: {
    captured_at: capturedAt,
    sources: [evidenceSource],
  },
  facts: {
    revision: fact("exact-revision-used-by-promotable-local-studio-evidence"),
    "weights.format": fact("file-backed-GGUF-artifact-used-by-accepted-runtime"),
    "weights.precision": fact("accepted-artifact-is-the-PQ2_0-Bonsai-2-pack"),
    "weights.size_gb": fact("derived-from-SHA256-pinned-local-artifact-size"),
  },
};

const liveBenchmark = evidence.liveBenchmark;
const liveBenchmarkResult = liveBenchmark?.response?.body?.benchmark;
const liveBenchmarkValid =
  liveBenchmark?.accepted === true &&
  liveBenchmark?.response?.ok === true &&
  liveBenchmark?.response?.body?.success === true &&
  liveBenchmarkResult &&
  typeof liveBenchmarkResult === "object" &&
  Number(liveBenchmarkResult.prompt_tokens) > 0 &&
  Number(liveBenchmarkResult.completion_tokens) > 0 &&
  Number(liveBenchmarkResult.generation_tps) > 0;
const fileBenchmarkReceipts = (evidence.benchmarks ?? [])
  .filter(validFileReceipt)
  .map(safeFileReceipt);
if (!liveBenchmarkValid && fileBenchmarkReceipts.length === 0) {
  throw new Error("benchmark evidence has neither an accepted live run nor a valid file receipt");
}
const benchmark = liveBenchmarkValid
  ? {
      kind: "local-studio-controller",
      requested_prompt_tokens: liveBenchmark.requestedPromptTokens ?? null,
      result: liveBenchmarkResult,
    }
  : {
      kind: "file-backed",
      receipts: fileBenchmarkReceipts,
    };

const recipe = {
  schema_version: "local-ai-registry/v1",
  id: recipeId,
  recipe_source: "local-studio",
  status: "candidate",
  model_instance_id: modelInstanceId,
  hardware_id: hardwareId,
  hardware_count: 1,
  engine: {
    name: "llamacpp",
    version: expected.engineCommit,
    graph_mode: null,
  },
  capabilities: {
    chat: true,
    reasoning: null,
    tools: true,
    vision: null,
  },
  serving: {
    kv_cache_tokens: null,
    max_concurrency: 1,
    max_context_tokens: null,
    tensor_parallel: 1,
  },
  launch: {
    kind: "reference",
    source: "local-studio",
    url: sourceUrl,
    container: {
      state: "none",
      runtime: null,
      image: null,
      digest: null,
      compose_file: null,
      reason: "accepted-local-binary-runtime; portable-registry-launch-not-yet-packaged",
      captured_at: capturedAt,
      source: [evidenceSource],
    },
  },
  speed_sweep_ids: [],
  metadata: {
    local_studio: {
      evidence_schema: evidence.schemaVersion,
      evidence_sha256: evidenceSha256,
      source_revision: normalizedSourceRevision,
      recipe_id: expected.recipe,
      served_model: expected.model,
      intended_context_tokens: 32768,
      max_concurrency: 1,
      hardware: {
        architecture: expected.hardwareArch,
        controller_name: evidence?.summary?.matchingGpu?.name ?? expected.gpuName,
      },
      runtime: {
        ref: evidence.target.engineRef,
        artifact: safeFileReceipt(engineFile),
      },
      model: {
        repository: modelInstance.repository,
        revision: expected.modelRevision,
        artifact: safeFileReceipt(modelFile),
        projector: safeFileReceipt(projectorFile),
      },
      acceptance: {
        completion: evidence.summary.completionAccepted === true,
        tools: evidence.summary.toolCallAccepted === true,
        benchmark,
        sessions: acceptedSessions,
      },
      authority: {
        state: "candidate",
        note: "Local Studio evidence proves this exact card/runtime/model pair; registry publication remains separately reviewed.",
      },
    },
  },
  provenance: {
    captured_at: capturedAt,
    sources: [evidenceSource],
  },
  facts: {},
  description:
    "Candidate Ternary Bonsai 2 27B PQ2_0 recipe for one Radeon AI PRO R9700 using PrismML llama.cpp ROCm. Generated only from a fail-closed Local Studio acceptance bundle; registry publication remains separately reviewed.",
};

const modelDir = resolve(outputDir, "registry", "model-instance");
const recipeDir = resolve(outputDir, "registry", "recipe");
mkdirSync(modelDir, { recursive: true });
mkdirSync(recipeDir, { recursive: true });
const modelPath = resolve(modelDir, `${modelInstance.id}.json`);
const recipePath = resolve(recipeDir, `${recipe.id}.json`);
const manifestPath = resolve(outputDir, "handoff-manifest.json");

writeFileSync(modelPath, `${JSON.stringify(modelInstance, null, 2)}\n`);
writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      schema_version: "local-studio/registry-handoff/v1",
      generated_at: new Date().toISOString(),
      source_evidence_sha256: evidenceSha256,
      source_local_studio_revision: normalizedSourceRevision,
      hardware_id: hardwareId,
      model_instance_id: modelInstanceId,
      recipe_id: recipeId,
      files: {
        model_instance: `registry/model-instance/${basename(modelPath)}`,
        recipe: `registry/recipe/${basename(recipePath)}`,
      },
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(
  `${JSON.stringify(
    {
      model_instance: modelPath,
      recipe: recipePath,
      manifest: manifestPath,
    },
    null,
    2,
  )}\n`,
);
