#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const renderer = join(repoRoot, "scripts", "render-r9700-bonsai-registry-candidate.mjs");
const temp = mkdtempSync(join(tmpdir(), "local-studio-registry-handoff-"));

try {
  const evidencePath = join(temp, "accepted.json");
  const outputDir = join(temp, "out");
  const accepted = {
    schemaVersion: "local-studio/local-ai-evidence/v1",
    capturedAt: "2026-09-24T00:00:00.000Z",
    source: {
      localStudioRevision: "70b786743ceb4bce1d15b528b06b736f50ad0554",
      trackedCheckoutStatus: { status: 0, stdout: "", stderr: "", available: true },
    },
    hardware: {
      requiredArch: "gfx1201",
      requiredGpuName: "Radeon AI PRO R9700",
      architectures: ["gfx1201"],
    },
    controller: {
      status: { ok: true, status: 200, body: { running: true } },
      compatibility: { ok: true, status: 200, body: { checks: [] } },
      gpus: {
        ok: true,
        status: 200,
        body: { gpus: [{ name: "AMD Radeon AI PRO R9700", memory_total_mb: 32768 }] },
      },
    },
    target: {
      recipeId: "bonsai2-r9700-prism-rocm",
      model: "Ternary-Bonsai-2-27B-PQ2_0",
      modelRevision: "6ed5e12bf84b7a63069882c91dd9e9218647d17b",
      modelFile: {
        type: "file",
        reference: "/models/Ternary-Bonsai-2-27B-PQ2_0.gguf",
        sizeBytes: 7210000000,
        sha256: "a".repeat(64),
      },
      projectorFile: {
        type: "file",
        reference: "/models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf",
        sizeBytes: 629000000,
        sha256: "b".repeat(64),
      },
      engineRef: "PrismML-Eng/llama.cpp@9a9394a895b96003ca842a6041cb28ac49a108f7",
      engineFile: {
        type: "file",
        reference: "/runtime/llama-server",
        sizeBytes: 123456,
        sha256: "c".repeat(64),
      },
    },
    endpoint: {
      models: { ok: true, status: 200, body: { data: [{ id: "Ternary-Bonsai-2-27B-PQ2_0" }] } },
      advertisedModelIds: ["Ternary-Bonsai-2-27B-PQ2_0"],
      modelAdvertised: true,
      completion: { ok: true, status: 200, accepted: true },
      toolCall: {
        ok: true,
        status: 200,
        accepted: true,
        matchedFunction: "report_acceptance",
        arguments: { token: "LOCAL_AI_TOOL_ACCEPTED" },
      },
    },
    sessions: [
      {
        agent: "opencode",
        type: "file",
        reference: "/sessions/opencode-accepted.json",
        sizeBytes: 4567,
        sha256: "d".repeat(64),
      },
      {
        agent: "hermes",
        type: "file",
        reference: "/sessions/hermes-accepted.jsonl",
        sizeBytes: 8910,
        sha256: "e".repeat(64),
      },
    ],
    benchmarks: [],
    liveBenchmark: {
      accepted: true,
      requestedPromptTokens: 1000,
      response: {
        ok: true,
        status: 200,
        body: {
          success: true,
          benchmark: {
            prompt_tokens: 1000,
            completion_tokens: 128,
            generation_tps: 42.5,
          },
        },
      },
    },
    summary: {
      hardwareArchitectureAccepted: true,
      hardwareIdentityAccepted: true,
      controllerAccepted: true,
      compatibilityAccepted: true,
      endpointModelsAccepted: true,
      modelAdvertised: true,
      completionAccepted: true,
      toolProbeRequested: true,
      toolCallAccepted: true,
      sourceCheckoutAccepted: true,
      artifactProvenanceAccepted: true,
      sessionEvidenceAccepted: true,
      benchmarkEvidenceAccepted: true,
      candidatePromotable: true,
      localStudioRevision: "70b786743ceb4bce1d15b528b06b736f50ad0554",
      matchingGpu: { name: "AMD Radeon AI PRO R9700" },
    },
  };
  writeFileSync(evidencePath, JSON.stringify(accepted));

  const ok = spawnSync(
    process.execPath,
    [renderer, "--evidence", evidencePath, "--output-dir", outputDir],
    { encoding: "utf8" },
  );
  if (ok.status !== 0) {
    throw new Error(`renderer failed valid evidence: ${ok.stderr || ok.stdout}`);
  }

  const result = JSON.parse(ok.stdout);
  const model = JSON.parse(readFileSync(result.model_instance, "utf8"));
  const recipe = JSON.parse(readFileSync(result.recipe, "utf8"));
  const manifest = JSON.parse(readFileSync(result.manifest, "utf8"));

  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  const modelKeys = new Set([
    "schema_version",
    "id",
    "model_id",
    "repository",
    "url",
    "revision",
    "served_name",
    "weights",
    "kind",
    "huggingface",
    "provenance",
    "facts",
  ]);
  const recipeKeys = new Set([
    "schema_version",
    "id",
    "recipe_source",
    "status",
    "description",
    "model_instance_id",
    "hardware_id",
    "hardware_count",
    "engine",
    "launch",
    "serving",
    "capabilities",
    "metadata",
    "provenance",
    "facts",
    "speed_sweep_ids",
  ]);
  assert(
    Object.keys(model).every((key) => modelKeys.has(key)),
    "model-instance contains a field outside the registry schema",
  );
  assert(
    Object.keys(recipe).every((key) => recipeKeys.has(key)),
    "recipe contains a field outside the registry schema",
  );
  const validSlugSegment = (segment) => {
    if (typeof segment !== "string" || segment.length === 0) return false;
    const isLowerAlphaNum = (character) =>
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9");
    if (!isLowerAlphaNum(segment[0])) return false;
    return Array.from(segment.slice(1)).every(
      (character) => isLowerAlphaNum(character) || character === "." || character === "-",
    );
  };
  const validModelInstanceId = (id) =>
    typeof id === "string" &&
    id.split("--").every((segment) => validSlugSegment(segment));
  const validRecipeId = (id) => validSlugSegment(id) && !id.includes("--");

  assert(validModelInstanceId(model.id), "model-instance id violates registry schema");
  assert(validRecipeId(recipe.id), "recipe id violates registry schema");
  assert(recipe.launch.kind === "reference", "handoff launch must remain reference-only");
  assert(recipe.launch.container?.state === "none", "reference launch container state must be none");

  assert(
    model.id === "prism-ml-ternary-bonsai-2-27b-gguf--pq2-0",
    "unexpected model-instance id",
  );
  assert(model.revision === accepted.target.modelRevision, "model revision lost");
  assert(model.weights.precision === "PQ2_0", "model precision lost");
  assert(recipe.status === "candidate", "renderer must never emit validated status");
  assert(recipe.hardware_id === "radeon-ai-pro-r9700-32gb", "hardware id mismatch");
  assert(recipe.model_instance_id === model.id, "recipe/model-instance linkage mismatch");
  assert(recipe.capabilities.chat === true, "accepted chat capability not carried");
  assert(recipe.capabilities.tools === true, "accepted tools capability not carried");
  assert(recipe.capabilities.vision === null, "vision must remain unverified");
  assert(
    recipe.metadata.local_studio.acceptance.sessions.some(
      (entry) => entry.agent === "opencode" && entry.artifact.name === "opencode-accepted.json",
    ),
    "OpenCode session artifact basename missing",
  );
  assert(
    recipe.metadata.local_studio.acceptance.sessions.some(
      (entry) => entry.agent === "hermes" && entry.artifact.name === "hermes-accepted.jsonl",
    ),
    "Hermes session artifact basename missing",
  );
  assert(
    recipe.metadata.local_studio.acceptance.sessions
      .map((entry) => entry.agent)
      .sort()
      .join(",") === "hermes,opencode",
    "registry handoff did not preserve both accepted agent identities",
  );
  const serializedRecipe = JSON.stringify(recipe);
  const localFixturePaths = [
    accepted.target.modelFile.reference,
    accepted.target.projectorFile.reference,
    accepted.target.engineFile.reference,
    ...accepted.sessions.map((entry) => entry.reference),
  ];
  assert(
    localFixturePaths.every((path) => !serializedRecipe.includes(path)),
    "a source machine-local path was copied into the registry recipe",
  );
  const absolutePathValues = [];
  const visitStrings = (value, pointer = "$") => {
    if (typeof value === "string") {
      if (value.startsWith("/")) absolutePathValues.push({ pointer, value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visitStrings(entry, `${pointer}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, entry]) =>
        visitStrings(entry, `${pointer}.${key}`),
      );
    }
  };
  visitStrings(recipe);
  assert(
    absolutePathValues.length === 0,
    `absolute filesystem paths leaked into registry recipe: ${JSON.stringify(absolutePathValues)}`,
  );
  assert(
    manifest.source_local_studio_revision === accepted.source.localStudioRevision,
    "handoff manifest source revision mismatch",
  );
  assert(
    recipe.provenance.sources[0].commit === accepted.source.localStudioRevision,
    "recipe provenance is not pinned to the accepted Local Studio commit",
  );
  assert(
    model.provenance.sources[0].commit === accepted.source.localStudioRevision,
    "model-instance provenance is not pinned to the accepted Local Studio commit",
  );
  assert(
    manifest.files.model_instance ===
      "registry/model-instance/prism-ml-ternary-bonsai-2-27b-gguf--pq2-0.json",
    "model-instance handoff path does not mirror registry layout",
  );
  assert(
    manifest.files.recipe ===
      "registry/recipe/llamacpp-bonsai2-pq2-radeon-ai-pro-r9700-32gb-tp1.json",
    "recipe handoff path does not mirror registry layout",
  );

  const rejectedPath = join(temp, "rejected.json");
  writeFileSync(
    rejectedPath,
    JSON.stringify({
      ...accepted,
      summary: { ...accepted.summary, candidatePromotable: false },
    }),
  );
  const rejected = spawnSync(
    process.execPath,
    [renderer, "--evidence", rejectedPath, "--output-dir", join(temp, "reject-out")],
    { encoding: "utf8" },
  );
  assert(rejected.status !== 0, "renderer accepted non-promotable evidence");

  const tamperedPath = join(temp, "tampered.json");
  writeFileSync(
    tamperedPath,
    JSON.stringify({
      ...accepted,
      target: {
        ...accepted.target,
        modelFile: { ...accepted.target.modelFile, sha256: "not-a-sha256" },
      },
    }),
  );
  const tampered = spawnSync(
    process.execPath,
    [renderer, "--evidence", tamperedPath, "--output-dir", join(temp, "tampered-out")],
    { encoding: "utf8" },
  );
  assert(tampered.status !== 0, "renderer accepted a forged artifact receipt");

  const override = spawnSync(
    process.execPath,
    [
      renderer,
      "--evidence",
      evidencePath,
      "--output-dir",
      join(temp, "override-out"),
      "--hardware-id",
      "some-other-card",
    ],
    { encoding: "utf8" },
  );
  assert(override.status !== 0, "renderer silently accepted a registry identity override");

  process.stdout.write("registry handoff contract PASS\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
