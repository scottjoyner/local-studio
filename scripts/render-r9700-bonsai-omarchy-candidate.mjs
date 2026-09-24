#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.lastIndexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null;
};

const handoffDir = value("--registry-handoff");
const imageReceiptPath = value("--published-image-receipt");
const outputDir = resolve(value("--output-dir") ?? "omarchy-handoff");
if (!handoffDir || !imageReceiptPath) {
  throw new Error("--registry-handoff and --published-image-receipt are required");
}

const handoffRoot = resolve(handoffDir);
const manifestPath = resolve(handoffRoot, "handoff-manifest.json");
const handoffManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (handoffManifest?.schema_version !== "local-studio/registry-handoff/v1") {
  throw new Error("unsupported registry handoff manifest");
}

const expectedRecipeId = "llamacpp-bonsai2-pq2-radeon-ai-pro-r9700-32gb-tp1";
const expectedModelId = "prism-ml-ternary-bonsai-2-27b-gguf--pq2-0";
if (
  handoffManifest.recipe_id !== expectedRecipeId ||
  handoffManifest.model_instance_id !== expectedModelId ||
  handoffManifest.hardware_id !== "radeon-ai-pro-r9700-32gb"
) {
  throw new Error("registry handoff identity mismatch");
}

const recipePath = resolve(handoffRoot, handoffManifest.files.recipe);
const modelPath = resolve(handoffRoot, handoffManifest.files.model_instance);
const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
const model = JSON.parse(readFileSync(modelPath, "utf8"));

if (
  recipe?.id !== expectedRecipeId ||
  recipe?.status !== "candidate" ||
  recipe?.launch?.kind !== "reference" ||
  recipe?.hardware_id !== "radeon-ai-pro-r9700-32gb" ||
  recipe?.model_instance_id !== expectedModelId
) {
  throw new Error("registry recipe is not the expected candidate reference launch");
}
if (
  model?.id !== expectedModelId ||
  model?.revision !== "6ed5e12bf84b7a63069882c91dd9e9218647d17b" ||
  model?.weights?.precision !== "PQ2_0"
) {
  throw new Error("registry model-instance identity mismatch");
}

const imageReceiptRaw = readFileSync(resolve(imageReceiptPath));
const imageReceipt = JSON.parse(imageReceiptRaw.toString("utf8"));
if (
  imageReceipt?.schemaVersion !== "local-studio/r9700-bonsai-published-image/v1" ||
  imageReceipt?.publishable !== true
) {
  throw new Error("published image receipt is not authoritative");
}
if (!/^[^\s]+@sha256:[0-9a-f]{64}$/i.test(String(imageReceipt.registryImage ?? ""))) {
  throw new Error("published image receipt is not digest pinned");
}
if (
  imageReceipt.registryManifestDigest !==
  imageReceipt.registryImage.slice(imageReceipt.registryImage.lastIndexOf("@") + 1).toLowerCase()
) {
  throw new Error("published image receipt manifest digest mismatch");
}
if (
  !/^sha256:[0-9a-f]{64}$/i.test(String(imageReceipt.registryConfigDigest ?? "")) ||
  imageReceipt.registryConfigDigest !== String(imageReceipt.localImageId).toLowerCase()
) {
  throw new Error("published image receipt is not bound to the local image id");
}

const generatedAt = new Date().toISOString();
const packagedRecipe = {
  ...recipe,
  draft_launch: {
    kind: "docker",
    image: imageReceipt.registryImage,
    arguments: [],
    mounts: [
      {
        source: "${MODEL_ROOT}",
        target: "/opt/models",
        read_only: false,
      },
    ],
    host_port: 8080,
    container_port: 8080,
    accelerator_backend: "amd-rocm",
    devices: ["/dev/kfd", "/dev/dri"],
    synthesized: {
      template: "local-studio-r9700-bonsai2-rocm-v1",
      generated_at: generatedAt,
      image_provenance: `local-studio-build:${imageReceipt.sourceRevision}`,
    },
  },
  metadata: {
    ...recipe.metadata,
    local_studio: {
      ...recipe.metadata?.local_studio,
      portable_image: {
        registry_image: imageReceipt.registryImage,
        manifest_digest: imageReceipt.registryManifestDigest,
        config_digest: imageReceipt.registryConfigDigest,
        rocm_base_image: imageReceipt.rocmBaseImage,
        image_source_revision: imageReceipt.sourceRevision,
        published_receipt_sha256: createHash("sha256")
          .update(imageReceiptRaw)
          .digest("hex"),
      },
    },
  },
};

const registryModelDir = resolve(outputDir, "registry", "model-instance");
const registryRecipeDir = resolve(outputDir, "registry", "recipe");
mkdirSync(registryModelDir, { recursive: true });
mkdirSync(registryRecipeDir, { recursive: true });
const modelOut = resolve(registryModelDir, basename(modelPath));
const recipeOut = resolve(registryRecipeDir, basename(recipePath));
writeFileSync(modelOut, `${JSON.stringify(model, null, 2)}\n`, "utf8");
writeFileSync(recipeOut, `${JSON.stringify(packagedRecipe, null, 2)}\n`, "utf8");

const packageManifest = {
  schema_version: "local-studio/omarchy-package/v1",
  generated_at: generatedAt,
  source_registry_handoff_sha256: createHash("sha256")
    .update(readFileSync(manifestPath))
    .digest("hex"),
  published_image_receipt_sha256: createHash("sha256")
    .update(imageReceiptRaw)
    .digest("hex"),
  image: imageReceipt.registryImage,
  files: {
    model_instance: `registry/model-instance/${basename(modelOut)}`,
    recipe: `registry/recipe/${basename(recipeOut)}`,
  },
};
const packageManifestPath = resolve(outputDir, "omarchy-package-manifest.json");
writeFileSync(
  packageManifestPath,
  `${JSON.stringify(packageManifest, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify(
    {
      model_instance: modelOut,
      recipe: recipeOut,
      manifest: packageManifestPath,
    },
    null,
    2,
  )}\n`,
);
