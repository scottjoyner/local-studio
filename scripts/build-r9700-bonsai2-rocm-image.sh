#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGING_DIR="$REPO_ROOT/packaging/r9700-bonsai2-rocm"
ROCM_BASE_IMAGE="rocm/dev-ubuntu-24.04:7.2.1-complete@sha256:3db551c4e1229aac1857ac44fcb6141bb749f41348eb572452f11279153c13c3"
OUTPUT_IMAGE="${LOCAL_STUDIO_BONSAI_IMAGE:-local/r9700-bonsai2-rocm:candidate}"
RECEIPT="${LOCAL_STUDIO_BONSAI_IMAGE_RECEIPT:-$PACKAGING_DIR/build-receipt.json}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required" >&2
  exit 2
fi

source_revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: source checkout does not have an exact Git revision" >&2
  exit 2
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]]; then
  echo "error: tracked Local Studio checkout is not clean" >&2
  exit 2
fi
if [[ ! "$ROCM_BASE_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "error: ROCm base image is not digest pinned" >&2
  exit 2
fi

docker build \
  --file "$PACKAGING_DIR/Dockerfile" \
  --build-arg "ROCM_BASE_IMAGE=$ROCM_BASE_IMAGE" \
  --build-arg "LOCAL_STUDIO_SOURCE_REVISION=$source_revision" \
  --tag "$OUTPUT_IMAGE" \
  "$REPO_ROOT"

image_id="$(docker image inspect --format '{{.Id}}' "$OUTPUT_IMAGE")"
if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "error: docker did not return a content-addressed local image id" >&2
  exit 1
fi

mkdir -p "$(dirname "$RECEIPT")"
SOURCE_REVISION="$source_revision" \
ROCM_BASE_IMAGE="$ROCM_BASE_IMAGE" \
OUTPUT_IMAGE="$OUTPUT_IMAGE" \
IMAGE_ID="$image_id" \
RECEIPT="$RECEIPT" \
node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";

const receipt = {
  schemaVersion: "local-studio/r9700-bonsai-image-build/v1",
  capturedAt: new Date().toISOString(),
  sourceRevision: process.env.SOURCE_REVISION,
  rocmBaseImage: process.env.ROCM_BASE_IMAGE,
  localImage: process.env.OUTPUT_IMAGE,
  localImageId: process.env.IMAGE_ID,
  registryDigest: null,
  publishable: false,
};
writeFileSync(process.env.RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
NODE

printf '%s\n' "$RECEIPT"
printf '%s\n' "local image id: $image_id"
printf '%s\n' "registry digest: not captured; this receipt is not publish authority"
