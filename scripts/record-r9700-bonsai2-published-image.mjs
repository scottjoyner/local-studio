#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.lastIndexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null;
};

const buildReceiptPath = value("--build-receipt");
const image = value("--image");
const output = resolve(value("--output") ?? "published-image-receipt.json");
if (!buildReceiptPath || !image) {
  throw new Error("--build-receipt and --image are required");
}
if (!/^[^\s]+@sha256:[0-9a-f]{64}$/i.test(image)) {
  throw new Error("--image must be a digest-pinned registry reference");
}

const buildRaw = readFileSync(resolve(buildReceiptPath));
const build = JSON.parse(buildRaw.toString("utf8"));
if (build?.schemaVersion !== "local-studio/r9700-bonsai-image-build/v1") {
  throw new Error("unsupported build receipt");
}
if (build?.publishable !== false || build?.registryDigest !== null) {
  throw new Error("build receipt authority boundary is invalid");
}
if (!/^sha256:[0-9a-f]{64}$/i.test(String(build?.localImageId ?? ""))) {
  throw new Error("build receipt local image id is invalid");
}

const inspect = spawnSync(
  "docker",
  ["buildx", "imagetools", "inspect", "--raw", image],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (inspect.status !== 0) {
  throw new Error(`remote image inspection failed: ${inspect.stderr || inspect.stdout}`);
}

let manifest;
try {
  manifest = JSON.parse(inspect.stdout);
} catch {
  throw new Error("remote image inspection did not return JSON");
}
const configDigest = manifest?.config?.digest;
if (typeof configDigest !== "string") {
  throw new Error(
    "published image must resolve to a single-platform manifest with a config digest",
  );
}
if (configDigest.toLowerCase() !== build.localImageId.toLowerCase()) {
  throw new Error(
    `published image config digest ${configDigest} does not match local build ${build.localImageId}`,
  );
}

const registryManifestDigest = image.slice(image.lastIndexOf("@") + 1).toLowerCase();
const receipt = {
  schemaVersion: "local-studio/r9700-bonsai-published-image/v1",
  capturedAt: new Date().toISOString(),
  sourceRevision: build.sourceRevision,
  rocmBaseImage: build.rocmBaseImage,
  localImageId: build.localImageId.toLowerCase(),
  buildReceiptSha256: createHash("sha256").update(buildRaw).digest("hex"),
  registryImage: image,
  registryManifestDigest,
  registryConfigDigest: configDigest.toLowerCase(),
  mediaType: manifest.mediaType ?? null,
  publishable: true,
};
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
