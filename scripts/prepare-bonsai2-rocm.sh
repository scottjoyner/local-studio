#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="prism-b10709-9a9394a"
RELEASE_COMMIT="9a9394a895b96003ca842a6041cb28ac49a108f7"
RELEASE_ASSET="llama-${RELEASE_TAG}-bin-ubuntu-rocm-7.2-x64.tar.gz"
RELEASE_SHA256="230f879d538bb9f794d25c908bc8c0f676774c41c3e70ea719131c86d899841d"
RELEASE_URL="https://github.com/PrismML-Eng/llama.cpp/releases/download/${RELEASE_TAG}/${RELEASE_ASSET}"
MODEL_REPO="prism-ml/Ternary-Bonsai-2-27B-gguf"
MODEL_REVISION="6ed5e12bf84b7a63069882c91dd9e9218647d17b"
MODEL_FILE="Ternary-Bonsai-2-27B-PQ2_0.gguf"
MODEL_SHA256="3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1"
MMPROJ_FILE="Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf"
MMPROJ_SHA256="6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903"
REQUIRED_ARCH="${LOCAL_STUDIO_BONSAI_REQUIRED_ARCH:-gfx1201}"
ROOT="${LOCAL_STUDIO_BONSAI_ROOT:-$HOME/.local/share/local-studio/experimental/bonsai2-r9700}"
BIN_DIR="$ROOT/runtime/${RELEASE_TAG}"
MODEL_DIR="$ROOT/models"
RECIPE_PATH="${LOCAL_STUDIO_BONSAI_RECIPE:-$ROOT/bonsai2-r9700.recipe.json}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "error: this bootstrap is for Linux x86_64 ROCm hosts" >&2
  exit 2
fi

if ! command -v rocminfo >/dev/null 2>&1; then
  echo "error: rocminfo is required to verify the ROCm device architecture" >&2
  exit 2
fi

if ! rocminfo 2>/dev/null | grep -Eiq "\b${REQUIRED_ARCH}\b"; then
  echo "error: required ROCm architecture ${REQUIRED_ARCH} was not reported by rocminfo" >&2
  exit 2
fi

mkdir -p "$BIN_DIR" "$MODEL_DIR"

LLAMA_SERVER="$(find "$BIN_DIR" -type f -name llama-server -print -quit 2>/dev/null || true)"
if [[ -z "$LLAMA_SERVER" ]]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 --progress-bar "$RELEASE_URL" -o "$tmp"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$tmp" "$RELEASE_URL"
  else
    echo "error: curl or wget is required" >&2
    exit 2
  fi
  actual="$(sha256sum "$tmp" | awk '{print $1}')"
  if [[ "$actual" != "$RELEASE_SHA256" ]]; then
    echo "error: PrismML runtime checksum mismatch: $actual" >&2
    exit 1
  fi
  tar -xzf "$tmp" -C "$BIN_DIR" --strip-components=1 2>/dev/null || tar -xzf "$tmp" -C "$BIN_DIR"
  LLAMA_SERVER="$(find "$BIN_DIR" -type f -name llama-server -print -quit 2>/dev/null || true)"
  if [[ -z "$LLAMA_SERVER" ]]; then
    echo "error: llama-server was not found after extracting the PrismML ROCm release" >&2
    exit 1
  fi
fi

if [[ ! -f "$MODEL_DIR/$MODEL_FILE" || ! -f "$MODEL_DIR/$MMPROJ_FILE" ]]; then
  if ! command -v hf >/dev/null 2>&1; then
    echo "error: the Hugging Face 'hf' CLI is required to download Bonsai 2" >&2
    exit 2
  fi
  hf download "$MODEL_REPO" "$MODEL_FILE" "$MMPROJ_FILE" \
    --revision "$MODEL_REVISION" \
    --local-dir "$MODEL_DIR"
fi

verify_sha256() {
  local path="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual="$(sha256sum "$path" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "error: $label checksum mismatch: expected $expected, got $actual" >&2
    exit 1
  fi
}

verify_sha256 "$MODEL_DIR/$MODEL_FILE" "$MODEL_SHA256" "Bonsai 2 PQ2 model"
verify_sha256 "$MODEL_DIR/$MMPROJ_FILE" "$MMPROJ_SHA256" "Bonsai 2 projector"

sha256sum "$LLAMA_SERVER" "$MODEL_DIR/$MODEL_FILE" "$MODEL_DIR/$MMPROJ_FILE" > "$ROOT/artifacts.sha256"

LLAMA_SERVER="$LLAMA_SERVER" MODEL_PATH="$MODEL_DIR/$MODEL_FILE" MMPROJ_PATH="$MODEL_DIR/$MMPROJ_FILE" RECIPE_PATH="$RECIPE_PATH" node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";

const recipe = {
  id: "bonsai2-r9700-prism-rocm",
  name: "Ternary Bonsai 2 27B (R9700 / Prism ROCm)",
  model_path: process.env.MODEL_PATH,
  vision: true,
  backend: "llamacpp",
  runtime: {
    kind: "binary",
    ref: process.env.LLAMA_SERVER,
    label: "PrismML llama.cpp prism-b10709-9a9394a ROCm 7.2",
  },
  env_vars: null,
  tensor_parallel_size: 1,
  pipeline_parallel_size: 1,
  max_model_len: 32768,
  gpu_memory_utilization: 0.9,
  kv_cache_dtype: "auto",
  max_num_seqs: 1,
  trust_remote_code: false,
  tool_call_parser: null,
  reasoning_parser: null,
  enable_auto_tool_choice: false,
  quantization: "PQ2_0",
  dtype: null,
  host: "127.0.0.1",
  port: 8000,
  served_model_name: "Ternary-Bonsai-2-27B-PQ2_0",
  python_path: null,
  extra_args: {
    "gpu-layers": 999,
    "flash-attn": "on",
    jinja: true,
    mmproj: process.env.MMPROJ_PATH,
  },
  max_thinking_tokens: 2048,
  thinking_mode: "conservative",
};

writeFileSync(process.env.RECIPE_PATH, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");
NODE

cat <<EOF
Prepared candidate R9700/Bonsai 2 runtime:
  llama-server: $LLAMA_SERVER
  model:        $MODEL_DIR/$MODEL_FILE
  mmproj:       $MODEL_DIR/$MMPROJ_FILE
  recipe:       $RECIPE_PATH
  engine ref:   PrismML-Eng/llama.cpp@$RELEASE_COMMIT
  model ref:    $MODEL_REPO@$MODEL_REVISION
  model sha256: $MODEL_SHA256
  mmproj sha256: $MMPROJ_SHA256

Import the recipe with:
  curl -fsS -X POST http://127.0.0.1:8080/recipes \
    -H 'Content-Type: application/json' \
    --data-binary @$RECIPE_PATH
EOF
