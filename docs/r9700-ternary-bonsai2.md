# Radeon AI PRO R9700 + Ternary Bonsai 2 validation

This is an experimental validation lane for a single Radeon AI PRO R9700 (`gfx1201`) running Ternary Bonsai 2 27B through Local Studio.

The lane does not change routing authority, automatic model admission, or the existing Local Studio compute lease model. It produces reproducible evidence that can later be promoted into a registry recipe or consumed by a higher-level agent runtime.

## What Local Studio already provides

The current `dev` compute path already has the AMD mechanisms this lane needs:

- ROCm discovery through `amd-smi`, `rocm-smi`, and `rocminfo`.
- ROCm device selection through both `HIP_VISIBLE_DEVICES` and `ROCR_VISIBLE_DEVICES`.
- Docker ROCm passthrough through `/dev/kfd`, `/dev/dri`, and the `video` / `render` groups.
- A llama.cpp backend that accepts an operator-selected binary runtime.
- A controller-owned OpenAI-compatible `/v1` proxy and bounded launch lifecycle.

Bonsai 2 therefore does not need a new accelerator abstraction. The model-specific variable is the llama.cpp runtime: Bonsai 2 currently requires PrismML's fork because the Hadamard activation transform is not yet in stock llama.cpp.

## Pinned candidate inputs

The bootstrap script intentionally pins both runtime and weights.

| Input | Pin |
| --- | --- |
| PrismML llama.cpp release | `prism-b10709-9a9394a` |
| PrismML llama.cpp commit | `9a9394a895b96003ca842a6041cb28ac49a108f7` |
| Linux ROCm asset | `llama-prism-b10709-9a9394a-bin-ubuntu-rocm-7.2-x64.tar.gz` |
| Runtime asset SHA-256 | `230f879d538bb9f794d25c908bc8c0f676774c41c3e70ea719131c86d899841d` |
| Model repo | `prism-ml/Ternary-Bonsai-2-27B-gguf` |
| Model revision | `6ed5e12bf84b7a63069882c91dd9e9218647d17b` |
| Initial pack | `Ternary-Bonsai-2-27B-PQ2_0.gguf` |
| Vision projector | `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf` |

The initial recipe uses a 32K context and one concurrent request. Those are conservative validation settings, not a claim about the R9700's maximum capacity.

## Prepare the candidate

Run this on the R9700 Linux host:

```bash
bash scripts/prepare-bonsai2-rocm.sh
```

The script fails closed unless `rocminfo` reports `gfx1201`. It downloads the pinned PrismML ROCm binary, verifies the published release SHA-256, downloads the two pinned Hugging Face artifacts, hashes the local runtime/model/projector, and writes:

```text
~/.local/share/local-studio/experimental/bonsai2-r9700/
├── artifacts.sha256
├── bonsai2-r9700.recipe.json
├── models/
└── runtime/
```

Override the root with `LOCAL_STUDIO_BONSAI_ROOT`.

## One-command physical acceptance

After an existing OpenCode session has exercised the intended local endpoint, the full candidate check can be run on the R9700 host with:

```bash
# Reuse an existing OpenCode session:
export OPENCODE_SESSION_ID=<existing-session-id>

# Pin the provider that maps to Local Studio. If omitted on the first run,
# the exporter still writes a receipt showing the observed provider but
# exits non-promotable so the provider can be pinned explicitly.
export OPENCODE_EXPECTED_PROVIDER=<local-studio-provider-id>

# Or prove the same endpoint through Hermes:
export HERMES_SESSION_ID=<existing-hermes-session-id>

bash scripts/validate-bonsai2-r9700.sh
```

When `OPENCODE_SESSION_ID` is set, the harness invokes OpenCode's sanitized JSON export itself and writes two immutable artifacts under the candidate root by default: `opencode-session.sanitized.json` and `opencode-session.receipt.json`. The receipt checks only the final user turn, so earlier remote/model history does not invalidate a later local acceptance turn; every assistant message after that final user message must stay on the explicitly expected provider/model and at least one tool call must complete.

The Local Studio evidence collector now independently verifies that receipt/export pair. It recomputes the sanitized export SHA-256 and size, reparses the export, checks the session ID, revalidates the final-turn provider/model, verifies completed tool evidence, rejects assistant errors/fallbacks, and compares all of that with the receipt. The main manifest records the result under `clients.opencode.sessionEvidence`. OpenCode receives promotion credit only when that verifier is accepted. A generic hashed OpenCode file remains diagnostic evidence but cannot satisfy the session promotion gate by itself.

If immutable legacy OpenCode evidence is already a known file, `OPENCODE_SESSION_FILE=/path/to/session-or-report.jsonl` is still recorded for diagnostics and historical comparison, but it does not receive promotion credit by itself. The linked sanitized-export + receipt path is the required OpenCode acceptance evidence. Override the output paths with `OPENCODE_SESSION_EXPORT` and `OPENCODE_SESSION_RECEIPT`, and raise the minimum completed tool count with `OPENCODE_MIN_COMPLETED_TOOLS`.

For Hermes, `HERMES_SESSION_ID` asks the current `hermes` CLI to export that session as a redacted JSONL receipt before capture; the default output is `$LOCAL_STUDIO_BONSAI_ROOT/hermes-session.evidence.jsonl`. Set `HERMES_SESSION_FILE=/path/to/already-exported-session.jsonl` to reuse an existing export instead. OpenCode and Hermes evidence can both be supplied in the same run.

The harness prepares the pinned runtime/model, upserts the recipe, launches it only when it is not already running, waits for readiness, runs the built-in benchmark, captures controller/ROCm/client evidence, and prints the promotion blockers from the final manifest.

The OpenCode receipt is generated from the CLI's sanitized JSON export, which preserves session/model/tool state while redacting transcript and tool payload contents. Promotion through the automated path therefore carries a file hash, exact provider/model identity for the final turn, completed-tool evidence, and explicit fallback detection.

The command also probes Bonsai 2's native OpenAI-compatible `tools` response and requires a structured `report_acceptance` function call. It exits with status `3` when the candidate is healthy enough to inspect but still lacks one or more promotion gates. It never substitutes another model, device, runtime, or remote endpoint to make the verdict pass.


## Import and launch through Local Studio

With the controller on `127.0.0.1:8080`:

```bash
ROOT="${LOCAL_STUDIO_BONSAI_ROOT:-$HOME/.local/share/local-studio/experimental/bonsai2-r9700}"

AUTH=()
if [[ -n "${LOCAL_STUDIO_API_KEY:-}" ]]; then
  AUTH=(-H "Authorization: Bearer $LOCAL_STUDIO_API_KEY")
fi

curl -fsS "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  --data-binary "@$ROOT/bonsai2-r9700.recipe.json" \
  http://127.0.0.1:8080/recipes

curl -fsS "${AUTH[@]}" -X POST \
  http://127.0.0.1:8080/launch/bonsai2-r9700-prism-rocm

curl -fsS "${AUTH[@]}" \
  'http://127.0.0.1:8080/wait-ready?timeout=600'
```

The backend process remains loopback-bound and is reached through Local Studio's controller proxy.

## Capture evidence without copying session contents

`scripts/capture-local-ai-evidence.mjs` creates a portable JSON manifest. For file-backed OpenCode or Hermes session evidence it records the path, size, and SHA-256; it does not copy the session body into the report. An opaque session ID can also be supplied and is preserved as an opaque reference. For OpenCode config provenance, the collector prefers an explicit `--opencode-config`, then `OPENCODE_CONFIG`, then the current global `~/.config/opencode/opencode.jsonc` / `opencode.json` files; the older `endpoints.json` path is only a fallback. Pass the exact project-local config with `--opencode-config` when a session used one. With `--hermes`, the collector records the Hermes CLI version, resolved Hermes home (`--hermes-home`, then `HERMES_HOME`, then `~/.hermes`), and metadata for its `state.db` session store without copying or hashing the database contents.

A first R9700/OpenCode capture can look like:

```bash
ROOT="${LOCAL_STUDIO_BONSAI_ROOT:-$HOME/.local/share/local-studio/experimental/bonsai2-r9700}"

node scripts/capture-local-ai-evidence.mjs \
  --output "$ROOT/r9700-bonsai2-opencode.evidence.json" \
  --controller http://127.0.0.1:8080 \
  --require-arch gfx1201 \
  --require-gpu-name "Radeon AI PRO R9700" \
  --model Ternary-Bonsai-2-27B-PQ2_0 \
  --recipe bonsai2-r9700-prism-rocm \
  --model-revision 6ed5e12bf84b7a63069882c91dd9e9218647d17b \
  --model-file "$ROOT/models/Ternary-Bonsai-2-27B-PQ2_0.gguf" \
  --projector-file "$ROOT/models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf" \
  --engine-ref PrismML-Eng/llama.cpp@9a9394a895b96003ca842a6041cb28ac49a108f7 \
  --engine-file "$ROOT/runtime/prism-b10709-9a9394a/llama-server" \
  --opencode \
  --opencode-session ses_opaque_identifier \
  --session opencode=/path/to/existing/session-export-or-session-diff.json \
  --run-benchmark \
  --probe-tools \
  --artifact /path/to/existing/tool-output-report.json
```

For OpenCode specifically, `--opencode-session` checks the standard `~/.local/share/opencode/storage/session_diff/` locations first. If no immutable session file is present, the ID remains an opaque reference and cannot satisfy the promotion gate by itself; pass an existing session export or session diff as `--session opencode=...`. Tool-output reports can still be attached separately with `--artifact`. `--opencode` also records the OpenCode version, metadata for `~/.local/share/opencode/opencode.db`, and a SHA-256 of the resolved OpenCode config when present; it never copies the database or configuration contents into the report. Override those locations with `--opencode-root` and `--opencode-config`.

The collector also records:

- `rocminfo` architecture evidence and requires `gfx1201` by default.
- Local Studio `/gpus` identity evidence and requires a GPU name containing `Radeon AI PRO R9700` by default.
- `amd-smi` and `rocm-smi` snapshots when those tools are available.
- Local Studio `/status`, `/compat`, `/gpus`, and `/compute/engines`.
- `/v1/models`.
- A deterministic `/v1/chat/completions` acceptance request.
- With `--probe-tools`, a native OpenAI-compatible tools request that must return a structured `report_acceptance` call with the expected token.
- The Local Studio Git SHA and tracked-worktree status from the checkout that produced the report; promotion requires a clean tracked checkout.
- Optional benchmark and other artifact hashes.
- With `--run-benchmark`, the controller's existing `/benchmark` endpoint plus before/after `/v1/metrics/vllm` snapshots. This is accepted as benchmark evidence when it returns nonzero prompt tokens, completion tokens, and generation tok/s.
- A deterministic `summary.candidatePromotable` result. Promotion requires exact GPU architecture + R9700 identity, a clean exact Local Studio Git revision, hashed model/runtime provenance, a successful completion probe, the expected native structured tool call, and accepted agent evidence. For OpenCode, that means an independently verified receipt/export pair; for Hermes, it means hashed file-backed session evidence. A successful live controller benchmark or hashed benchmark artifact is also required.

The API key is read from `LOCAL_STUDIO_API_KEY` by default and is never written to the manifest. Use `--api-key-env NAME` if the controller credential lives in another environment variable.

## Promotion gates

Keep this lane candidate-only until all of these are evidenced by the same exact runtime/model pair:

1. `rocminfo` reports `gfx1201`, and Local Studio `/gpus` reports a GPU name containing `Radeon AI PRO R9700`.
2. The PrismML runtime binary, Bonsai model, and projector are pinned by revision and local SHA-256.
3. Local Studio `/compat` and compute-engine discovery are healthy enough to launch the candidate without bypassing device leases.
4. `/v1/models` exposes the intended served model, the deterministic completion probe succeeds, and the one-command acceptance harness receives the expected native structured tool call.
5. The Local Studio checkout is a clean tracked Git revision, and an existing or fresh OpenCode or Hermes session completes a representative local coding/tool task against that endpoint with hashed file-backed evidence.
6. The built-in controller benchmark succeeds (recommended via `--run-benchmark`) or a hashed benchmark artifact records equivalent performance evidence.
7. `summary.candidatePromotable` is `true` for the exact evidence bundle.
8. A second agent runtime, such as Hermes, may repeat the same acceptance flow. Its result is additional client evidence; it does not become model-routing or mutation authority.

A failure at any gate leaves the candidate unpromoted. Do not silently fall back to stock llama.cpp, a different model packing, another GPU, or a remote model.

## Relationship to Omarchy and a registry PR

The Omarchy local-AI work already models AMD devices separately from NVIDIA and consumes recipe-shaped runtime/model metadata. The useful contribution from this lane is evidence, not another routing layer.

Once the R9700 capture is green, the manifest contains the fields needed to turn this into a registry candidate:

- exact hardware architecture,
- exact engine revision and binary digest,
- exact model revision and local digest,
- served model identity,
- context/concurrency used,
- compatibility result,
- completion acceptance,
- benchmark artifacts,
- OpenCode/Hermes session provenance.

That keeps Local Studio responsible for lifecycle and observation while a registry or Omarchy integration can decide whether to publish the recipe under its own review and trust policy.
