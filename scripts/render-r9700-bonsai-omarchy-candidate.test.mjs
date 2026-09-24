#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const renderer = join(repoRoot, "scripts", "render-r9700-bonsai-omarchy-candidate.mjs");
const dockerfile = readFileSync(
  join(repoRoot, "packaging", "r9700-bonsai2-rocm", "Dockerfile"),
  "utf8",
);
const acquire = readFileSync(
  join(repoRoot, "packaging", "r9700-bonsai2-rocm", "omp-acquire.sh"),
  "utf8",
);
const temp = mkdtempSync(join(tmpdir(), "local-studio-omarchy-package-"));

try {
  const handoff = join(temp, "registry-handoff");
  const modelDir = join(handoff, "registry", "model-instance");
  const recipeDir = join(handoff, "registry", "recipe");
  mkdirSync(modelDir, { recursive: true });
  mkdirSync(recipeDir, { recursive: true });

  const modelName = "prism-ml-ternary-bonsai-2-27b-gguf--pq2-0.json";
  const recipeName = "llamacpp-bonsai2-pq2-radeon-ai-pro-r9700-32gb-tp1.json";
  const model = {
    schema_version: "local-ai-registry/v1",
    id: "prism-ml-ternary-bonsai-2-27b-gguf--pq2-0",
    model_id: "bonsai-27b",
    repository: "prism-ml/Ternary-Bonsai-2-27B-gguf",
    revision: "6ed5e12bf84b7a63069882c91dd9e9218647d17b",
    served_name: "Ternary-Bonsai-2-27B-PQ2_0",
    weights: { precision: "PQ2_0" },
  };
  const recipe = {
    schema_version: "local-ai-registry/v1",
    id: "llamacpp-bonsai2-pq2-radeon-ai-pro-r9700-32gb-tp1",
    recipe_source: "local-studio",
    status: "candidate",
    model_instance_id: model.id,
    hardware_id: "radeon-ai-pro-r9700-32gb",
    hardware_count: 1,
    engine: {
      name: "llamacpp",
      version: "9a9394a895b96003ca842a6041cb28ac49a108f7",
      graph_mode: null,
    },
    launch: {
      kind: "reference",
      source: "local-studio",
      url: "https://github.com/scottjoyner/local-studio/pull/1",
      container: { state: "none" },
    },
    serving: { tensor_parallel: 1 },
    capabilities: { chat: true, reasoning: null, tools: true, vision: null },
    metadata: { local_studio: { evidence_sha256: "c".repeat(64) } },
    provenance: { captured_at: "2026-09-24T00:00:00Z", sources: [] },
    facts: {},
    speed_sweep_ids: [],
  };
  writeFileSync(join(modelDir, modelName), JSON.stringify(model));
  writeFileSync(join(recipeDir, recipeName), JSON.stringify(recipe));
  writeFileSync(
    join(handoff, "handoff-manifest.json"),
    JSON.stringify({
      schema_version: "local-studio/registry-handoff/v1",
      hardware_id: "radeon-ai-pro-r9700-32gb",
      model_instance_id: model.id,
      recipe_id: recipe.id,
      files: {
        model_instance: `registry/model-instance/${modelName}`,
        recipe: `registry/recipe/${recipeName}`,
      },
    }),
  );

  const imageDigest = `sha256:${"a".repeat(64)}`;
  const configDigest = `sha256:${"b".repeat(64)}`;
  const imageReceiptPath = join(temp, "published-image.json");
  const imageReceipt = {
    schemaVersion: "local-studio/r9700-bonsai-published-image/v1",
    capturedAt: "2026-09-24T00:00:00Z",
    sourceRevision: "d".repeat(40),
    rocmBaseImage:
      "rocm/dev-ubuntu-24.04:7.2.1-complete@sha256:3db551c4e1229aac1857ac44fcb6141bb749f41348eb572452f11279153c13c3",
    localImageId: configDigest,
    buildReceiptSha256: "e".repeat(64),
    registryImage: `ghcr.io/scottjoyner/r9700-bonsai2-rocm@${imageDigest}`,
    registryManifestDigest: imageDigest,
    registryConfigDigest: configDigest,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    publishable: true,
  };
  writeFileSync(imageReceiptPath, JSON.stringify(imageReceipt));

  const outputDir = join(temp, "out");
  const ok = spawnSync(
    process.execPath,
    [
      renderer,
      "--registry-handoff",
      handoff,
      "--published-image-receipt",
      imageReceiptPath,
      "--output-dir",
      outputDir,
    ],
    { encoding: "utf8" },
  );
  if (ok.status !== 0) {
    throw new Error(`renderer failed valid package: ${ok.stderr || ok.stdout}`);
  }

  const result = JSON.parse(ok.stdout);
  const packaged = JSON.parse(readFileSync(result.recipe, "utf8"));
  const packageManifest = JSON.parse(readFileSync(result.manifest, "utf8"));
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  assert(
    dockerfile.includes(
      "rocm/dev-ubuntu-24.04:7.2.1-complete@sha256:3db551c4e1229aac1857ac44fcb6141bb749f41348eb572452f11279153c13c3",
    ),
    "ROCm base image is not pinned by digest",
  );
  assert(
    dockerfile.includes(
      "230f879d538bb9f794d25c908bc8c0f676774c41c3e70ea719131c86d899841d",
    ),
    "Prism ROCm release archive hash is not pinned",
  );
  assert(
    acquire.includes(
      "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
    ) &&
      acquire.includes(
        "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903",
      ),
    "Bonsai model/projector hashes are not pinned in the image acquisition path",
  );

  assert(packaged.status === "candidate", "portable handoff changed validation status");
  assert(packaged.launch.kind === "reference", "portable handoff replaced observed launch");
  assert(packaged.draft_launch.kind === "docker", "portable docker draft is missing");
  assert(
    packaged.draft_launch.image === imageReceipt.registryImage,
    "portable draft lost the digest-pinned image",
  );
  assert(
    packaged.draft_launch.accelerator_backend === "amd-rocm",
    "portable draft lost the AMD backend",
  );
  assert(
    packaged.draft_launch.devices.join(",") === "/dev/kfd,/dev/dri",
    "portable draft lost ROCm devices",
  );
  assert(
    packaged.draft_launch.mounts[0].source === "${MODEL_ROOT}" &&
      packaged.draft_launch.mounts[0].target === "/opt/models",
    "portable draft model mount mismatch",
  );
  assert(
    packageManifest.image === imageReceipt.registryImage,
    "package manifest image mismatch",
  );

  const tagOnlyPath = join(temp, "tag-only.json");
  writeFileSync(
    tagOnlyPath,
    JSON.stringify({
      ...imageReceipt,
      registryImage: "ghcr.io/scottjoyner/r9700-bonsai2-rocm:latest",
      registryManifestDigest: null,
    }),
  );
  const tagOnly = spawnSync(
    process.execPath,
    [
      renderer,
      "--registry-handoff",
      handoff,
      "--published-image-receipt",
      tagOnlyPath,
      "--output-dir",
      join(temp, "tag-only-out"),
    ],
    { encoding: "utf8" },
  );
  assert(tagOnly.status !== 0, "renderer accepted a tag-only image");

  const mismatchPath = join(temp, "mismatch.json");
  writeFileSync(
    mismatchPath,
    JSON.stringify({
      ...imageReceipt,
      registryConfigDigest: `sha256:${"f".repeat(64)}`,
    }),
  );
  const mismatch = spawnSync(
    process.execPath,
    [
      renderer,
      "--registry-handoff",
      handoff,
      "--published-image-receipt",
      mismatchPath,
      "--output-dir",
      join(temp, "mismatch-out"),
    ],
    { encoding: "utf8" },
  );
  assert(mismatch.status !== 0, "renderer accepted an image/config mismatch");

  process.stdout.write("Omarchy package contract PASS\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
