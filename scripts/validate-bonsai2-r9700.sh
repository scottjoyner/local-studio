#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
ROOT="${LOCAL_STUDIO_BONSAI_ROOT:-$HOME/.local/share/local-studio/experimental/bonsai2-r9700}"
CONTROLLER="${LOCAL_STUDIO_URL:-http://127.0.0.1:8080}"
OUTPUT="${LOCAL_STUDIO_BONSAI_EVIDENCE:-$ROOT/r9700-bonsai2-acceptance.evidence.json}"
HERMES_SESSION_EXPORT="${HERMES_SESSION_EXPORT:-$ROOT/hermes-session.evidence.jsonl}"
OPENCODE_SESSION_EXPORT="${OPENCODE_SESSION_EXPORT:-$ROOT/opencode-session.sanitized.json}"
OPENCODE_SESSION_RECEIPT="${OPENCODE_SESSION_RECEIPT:-$ROOT/opencode-session.receipt.json}"
RECIPE="$ROOT/bonsai2-r9700.recipe.json"
MODEL="$ROOT/models/Ternary-Bonsai-2-27B-PQ2_0.gguf"
PROJECTOR="$ROOT/models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf"
MODEL_REVISION="6ed5e12bf84b7a63069882c91dd9e9218647d17b"
ENGINE_REF="PrismML-Eng/llama.cpp@9a9394a895b96003ca842a6041cb28ac49a108f7"
SERVED_MODEL="Ternary-Bonsai-2-27B-PQ2_0"
RECIPE_ID="bonsai2-r9700-prism-rocm"

bash "$REPO_ROOT/scripts/prepare-bonsai2-rocm.sh"

LLAMA_SERVER="$(find "$ROOT/runtime/prism-b10709-9a9394a" -type f -name llama-server -print -quit 2>/dev/null || true)"
if [[ -z "$LLAMA_SERVER" || ! -x "$LLAMA_SERVER" ]]; then
  echo "error: prepared PrismML llama-server is missing or not executable" >&2
  exit 2
fi

AUTH=()
if [[ -n "${LOCAL_STUDIO_API_KEY:-}" ]]; then
  AUTH=(-H "Authorization: Bearer $LOCAL_STUDIO_API_KEY")
fi

curl -fsS "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  --data-binary "@$RECIPE" \
  "$CONTROLLER/recipes" >/dev/null

recipe_state="$(
  curl -fsS "${AUTH[@]}" "$CONTROLLER/recipes" |
    RECIPE_ID="$RECIPE_ID" node --input-type=module -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const rows = JSON.parse(input);
        const recipe = Array.isArray(rows) ? rows.find((entry) => entry?.id === process.env.RECIPE_ID) : null;
        process.stdout.write(recipe?.status ?? "missing");
      });
    '
)"

if [[ "$recipe_state" != "running" && "$recipe_state" != "starting" ]]; then
  curl -fsS "${AUTH[@]}" -X POST "$CONTROLLER/launch/$RECIPE_ID" >/dev/null
fi

ready="$(
  curl -fsS "${AUTH[@]}" "$CONTROLLER/wait-ready?timeout=600" |
    node --input-type=module -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const payload = JSON.parse(input);
        process.stdout.write(payload?.ready === true ? "true" : "false");
      });
    '
)"

if [[ "$ready" != "true" ]]; then
  echo "error: Local Studio did not report the Bonsai candidate ready" >&2
  exit 1
fi

EVIDENCE_ARGS=(
  --output "$OUTPUT"
  --controller "$CONTROLLER"
  --model "$SERVED_MODEL"
  --recipe "$RECIPE_ID"
  --model-revision "$MODEL_REVISION"
  --model-file "$MODEL"
  --projector-file "$PROJECTOR"
  --engine-ref "$ENGINE_REF"
  --engine-file "$LLAMA_SERVER"
  --require-arch "${LOCAL_STUDIO_BONSAI_REQUIRED_ARCH:-gfx1201}"
  --require-gpu-name "${LOCAL_STUDIO_BONSAI_GPU_NAME:-Radeon AI PRO R9700}"
  --run-benchmark
  --benchmark-prompt-tokens "${LOCAL_STUDIO_BONSAI_BENCHMARK_TOKENS:-1000}"
  --probe-tools
)

if command -v opencode >/dev/null 2>&1 || [[ -n "${OPENCODE_SESSION_ID:-}" || -n "${OPENCODE_SESSION_FILE:-}" ]]; then
  EVIDENCE_ARGS+=(--opencode)
fi

if [[ -n "${OPENCODE_SESSION_ID:-}" ]]; then
  if ! command -v opencode >/dev/null 2>&1; then
    echo "error: OPENCODE_SESSION_ID was supplied but the opencode CLI is unavailable" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$OPENCODE_SESSION_EXPORT")" "$(dirname "$OPENCODE_SESSION_RECEIPT")"
  OPENCODE_EXPORT_ARGS=(
    --session "$OPENCODE_SESSION_ID"
    --expected-model "$SERVED_MODEL"
    --export-output "$OPENCODE_SESSION_EXPORT"
    --receipt-output "$OPENCODE_SESSION_RECEIPT"
    --min-completed-tools "${OPENCODE_MIN_COMPLETED_TOOLS:-1}"
  )
  if [[ -n "${OPENCODE_EXPECTED_PROVIDER:-}" ]]; then
    OPENCODE_EXPORT_ARGS+=(--expected-provider "$OPENCODE_EXPECTED_PROVIDER")
  fi
  node "$REPO_ROOT/scripts/export-opencode-session-evidence.mjs" "${OPENCODE_EXPORT_ARGS[@]}"
  EVIDENCE_ARGS+=(
    --opencode-session "$OPENCODE_SESSION_ID"
    --session "opencode=$OPENCODE_SESSION_RECEIPT"
    --artifact "$OPENCODE_SESSION_EXPORT"
  )
fi

if [[ -n "${OPENCODE_SESSION_FILE:-}" ]]; then
  EVIDENCE_ARGS+=(--session "opencode=$OPENCODE_SESSION_FILE")
fi

if [[ -n "${HERMES_SESSION_FILE:-}" ]]; then
  EVIDENCE_ARGS+=(--hermes --session "hermes=$HERMES_SESSION_FILE")
elif [[ -n "${HERMES_SESSION_ID:-}" ]]; then
  if ! command -v hermes >/dev/null 2>&1; then
    echo "error: HERMES_SESSION_ID was supplied but the hermes CLI is unavailable" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$HERMES_SESSION_EXPORT")"
  hermes sessions export "$HERMES_SESSION_EXPORT" \
    --format jsonl \
    --session-id "$HERMES_SESSION_ID" \
    --redact >/dev/null
  if [[ ! -s "$HERMES_SESSION_EXPORT" ]]; then
    echo "error: Hermes session export was not created: $HERMES_SESSION_EXPORT" >&2
    exit 2
  fi
  EVIDENCE_ARGS+=(--hermes --session "hermes=$HERMES_SESSION_EXPORT")
elif command -v hermes >/dev/null 2>&1; then
  EVIDENCE_ARGS+=(--hermes)
fi

node "$REPO_ROOT/scripts/capture-local-ai-evidence.mjs" "${EVIDENCE_ARGS[@]}"

OUTPUT="$OUTPUT" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const payload = JSON.parse(readFileSync(process.env.OUTPUT, "utf8"));
  const summary = payload.summary ?? {};
  const required = [
    "hardwareArchitectureAccepted",
    "hardwareIdentityAccepted",
    "sourceCheckoutAccepted",
    "controllerAccepted",
    "compatibilityAccepted",
    "endpointModelsAccepted",
    "modelAdvertised",
    "completionAccepted",
    "toolCallAccepted",
    "artifactProvenanceAccepted",
    "sessionEvidenceAccepted",
    "benchmarkEvidenceAccepted",
  ];
  const blockers = required.filter((key) => summary[key] !== true);
  process.stdout.write(JSON.stringify({
    candidatePromotable: summary.candidatePromotable === true,
    blockers,
    summary,
  }, null, 2) + "\n");
  if (summary.candidatePromotable !== true) process.exitCode = 3;
'
