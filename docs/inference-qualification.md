# Inference qualification diagnostics

Local Studio owns the repeatable runtime/recipe side of model qualification:
what request arguments a runtime needs, where its usable output is, whether
reasoning is eating the output budget, whether generation truncated, whether
the first token stalled, and whether the runtime is usable for bounded
benchmark work at all.

This is **not** a quality-ranking system. `auto-router` owns downstream
qualification and routing evidence. What lives here is trustworthy
runtime-level evidence that downstream tooling can consume.

The problem it solves: a reachable inference endpoint is not proof of a
correctly configured one. Across the last physical fleet campaign we saw
runtimes that answered canaries but failed real-source grounding, that
generated length-truncated output with no usable content, and that timed out
at 95 seconds. Each of those had to be reverse-engineered by hand.

## 1. Authority map

Local Studio already had the authorities this work builds on. Nothing here
replaces them.

| Concern | Existing authority | What this adds |
| --- | --- | --- |
| Recipe source of truth | `RecipeStore` over `<data_dir>/model-index.json` (`controller/src/modules/models/recipes/recipe-store.ts`); shape declared once in `controller/contracts/recipes.ts`, validated by `parseRecipe` in `recipe-serializer.ts` | Diagnostic profiles and evidence that reference recipes, never a second recipe store |
| Engine argument translation | The `Spelling` tables in `controller/src/modules/compute/engines/*.ts` driven by `tuningArguments` in `engines/shared.ts`; `extra_args` overrides via `mergeArguments` | A diagnostic-side support table that declares what each engine can honor, and marks the rest unsupported |
| Reasoning budget → engine flag | `serializeRecipeExtraArguments` in `compute/bridge.ts` maps `max_thinking_tokens` to `--reasoning-budget` for `llamacpp` only | The support *states* and mechanism, so a probe can report what is and is not reachable from a request |
| Reasoning separation | `controller/src/modules/proxy/reasoning.ts` (`createThinkRewriter`, `firstReasoningField`) | Reuses it verbatim to detect inline reasoning rather than adding a second extractor |
| Request argument translation | `proxy/content-normalizer.ts`, `proxy/chat-request.ts`, `proxy/openai-routes.ts` | Builds one bounded request body with the bounded-output field spelled per engine |
| Response normalization | `normalizeCompletionChoices` in `proxy/openai-routes.ts` | The probe deliberately does **not** pass through it (see §5) |
| Runtime identity reporting | `engines/runtimes/runtime-targets.ts` (docker image tag), `models/routes.ts` (`GET /v1/models`) | `GET /v1/models` plus caller-declared engine/image, recorded in the report |

## 2. Diagnostic profiles

Declared in `controller/contracts/inference-diagnostics.ts`, implemented in
`controller/src/modules/diagnostics/diagnostic-profiles.ts`.

| Profile | Output cap | Reasoning budget | Total timeout | First-token timeout | Question it answers |
| --- | --- | --- | --- | --- | --- |
| `protocol_canary` | 16 | none | 20 s | 10 s | Does the endpoint speak the dialect and return a well-formed choice? |
| `exact_grounding` | 32 | none | 45 s | 20 s | Can it copy a literal token verbatim? |
| `short_reasoning` | 256 | 256 | 95 s | 30 s | Does reasoning leave room for a final answer? |
| `bounded_code` | 256 | none | 60 s | 25 s | Does bounded output stop cleanly rather than truncating? |

Every profile pins input ceiling, output cap, temperature, `top_p`, reasoning
budget, total timeout, first-token timeout, streaming, and stop behavior. None
encodes a node name, hostname, or hardware placement.

`profileBoundsProblem` describes why a profile is unusable (non-positive caps, a
reasoning budget larger than the output cap, a first-token deadline that is not
inside the total deadline) and returns `null` when the profile is sound. It is
pure and returns a string, so the probe turns it into a typed
`DiagnosticProfileError` on the error channel rather than throwing across an
Effect boundary — a library caller can `Effect.catchTag("DiagnosticProfileError")`
it. No request is sent for a malformed profile.

The catalog is frozen at module load, so a caller that mutates a profile it was
handed cannot change the profile the next probe uses.

## 3. Reasoning-budget handling

One logical field, `max_thinking_tokens`, resolved per engine. Support is
never assumed.

| Engine | State | Mechanism | Flag | Reachable from a request? |
| --- | --- | --- | --- | --- |
| `llamacpp` | `SUPPORTED` | `server_flag` | `--reasoning-budget` | No — fixed at launch |
| `vllm` | `UNSUPPORTED` | `none` | — | No |
| `sglang` | `UNSUPPORTED` | `none` | — | No |
| `mlx` | `UNSUPPORTED` | `none` | — | No |
| `exllamav3` | `UNSUPPORTED` | `none` | — | No |
| undeclared / other | `UNSUPPORTED` | `none` | — | No |

States:

- `SUPPORTED` — the engine has a real equivalent and it is named.
- `UNSUPPORTED` — the engine has no equivalent. Reported, never faked.
- `IGNORED_BY_ENGINE` — a directive was expected to apply and the runtime
  answered without it taking effect. Reached from observation, not assumption.
- `INVALID_CONFIGURATION` — negative, non-integer, or larger than the profile's
  output cap.

`vLLM` and `SGLang` expose `--reasoning-parser`, which decides *where* reasoning
is reported, not *how much* is generated. That is a separation control, not a
budget control, and the table keeps the two dimensions apart.

`INVALID_CONFIGURATION` covers a value that is unusable on its own — negative or
non-integer — and, **only when an output cap is actually in play**, a budget
larger than that cap. The cap is a separate scope: a probe compares against its
own profile's `max_output_tokens`, while recipe evidence passes no cap at all,
because a recipe's declared budget is a property of the recipe and not of
whichever probe happens to read it. `compared_against_output_cap` records which
scope applied (`null` when none did). Getting this wrong makes a perfectly good
recipe look misconfigured merely because a probe ran with a tighter output cap.

`llama.cpp` behavior already in the tree, verified while building this:
`compute/bridge.ts` pushes `--reasoning-budget` only for `llamacpp`, only when
the value is a non-negative integer, and only when `extra_args` has not already
set it; `engines/llamacpp.ts` defaults `--reasoning-format deepseek`. There
were **no** tests covering either flag before this work; `test/diagnostics/`
now pins the support table and the reachability claim.

## 4. Response anatomy

`readResponseAnatomy` never merges reasoning into final content. It reports
`content`, `reasoning`, `inlined_reasoning`, `reasoning_merged_into_content`,
`tool_call_count`, `finish_reason`, `prompt_tokens`, `completion_tokens`,
`reasoning_tokens`, the detected `shape`, and the `observed_fields` present on
the body.

`tool_call_count` counts **distinct** calls, identified by the stream-local
`index` and falling back to the call `id`. A streamed call arrives as one frame
carrying its id and name followed by further frames carrying argument
fragments under the same `index`, so counting entries per frame reports one call
as however many argument chunks it happened to take.

A stream that closes without a `finish_reason` frame is annotated in `evidence`
rather than trusted: the content that arrived may be an incomplete turn, and none
of the nine classifications describes that case honestly, so the probe says so
instead of guessing.

Inline `<think>` residue is detected with the proxy's own extractor, so the
probe and the serving path agree on what counts as reasoning. This matters: a
runtime started with `--reasoning-format auto` returns thoughts inside
`content`, which looks like a 900-token answer and is not one.

### What the probe cannot see

Separation detection only works on reasoning that is actually *marked* — a
dedicated `reasoning_content` field, or an explicit `<think>` block. A runtime
that emits unmarked monologue as plain content is indistinguishable from a long
answer by content alone, so the probe cannot classify it as reasoning. What it
does instead:

- `reasoning_merged_into_content` is `true` whenever an explicit think block was
  found, and `inlined_reasoning_length` sizes it.
- `reasoning_separation` is downgraded to `IGNORED_BY_ENGINE` whenever inline
  reasoning was found, on **any** profile — the directive is a server-side
  flag, not something the request carries, so gating this on whether the profile
  asked for a reasoning budget would hide precisely the case that matters: a
  plain `exact_grounding` request answered with 900 tokens of monologue.
- `grounded_answer_match` is `false` for a profile with a known expected answer,
  so an unmarked monologue still fails a determinism check rather than passing as
  a correct answer.

Treat `grounded_answer_match: false` on `exact_grounding` as the signal for
this class, not `classification`.

OpenAI compatibility is untouched. The probe is a separate read-only path and
rewrites nothing that callers receive.

## 5. Why the probe does not go through the proxy

`proxy/openai-routes.ts` enforces model gating and then calls
`exposeReasoningAsContentWhenEmpty`, which promotes reasoning into `content`
when visible content is empty for `trinity-large-thinking`. Routing the probe
through the proxy would let the proxy decide a runtime looks healthy. The probe
therefore talks to the runtime directly, which also keeps it clear of request
authority, admission, and provider routing.

## 6. Failure classifications

Single-valued and ordered. The first matching rule wins.

| Order | Classification | Condition |
| --- | --- | --- |
| 1 | `FIRST_TOKEN_TIMEOUT` | Connection and headers arrived, no token in the first-token budget |
| 2 | `GENERATION_TIMEOUT` | Generation started and overran the total budget |
| 3 | `MODEL_NOT_LOADED` | No HTTP response, or 404/503 |
| 4 | `CONTEXT_REJECTED` | 400 whose body names a context/length refusal |
| 5 | `INVALID_RESPONSE_SHAPE` | Any other non-2xx, or a 2xx carrying no chat choices |
| 6 | `LENGTH_TRUNCATED` | `finish_reason == "length"` |
| 7 | `REASONING_ONLY` | Content empty, reasoning present, not truncated |
| 8 | `EMPTY_FINAL_CONTENT` | Content empty, no reasoning |
| 9 | `OUTPUT_OK` | Content present |

`finish_reason == "length"` outranks `REASONING_ONLY` on purpose: it names the
mechanism, which is the actionable part. The reasoning cost is not lost —
`reasoning_consumed_budget` is set whenever truncation happened with reasoning
present or a non-zero reasoning token count, and `reasoning_tokens` and
`reasoning_length` are always reported.

The shape that must never read as success:

```json
{ "reasoning_tokens": 256, "content_length": 0, "finish_reason": "length" }
```

reports `LENGTH_TRUNCATED`, `reasoning_consumed_budget: true`,
`bounded_output_viable: false`, and exit status 1.

Grounding correctness is deliberately **not** a classification. It is reported
as `grounded_answer_match`, which is evidence for downstream qualification and
keeps ranking out of Local Studio.

## 7. CLI

```bash
bun --cwd controller probe-inference-runtime.ts \
  --base-url http://127.0.0.1:8081 \
  --model Ternary-Bonsai-2-27B-PQ2_0 \
  --profile short_reasoning \
  --engine llamacpp \
  --engine-image ghcr.io/ggml-org/llama.cpp:server-rocm
```

Also available as `npm run probe:runtime -- <flags>`.

| Flag | Purpose |
| --- | --- |
| `--base-url` | Root of an already-running OpenAI-compatible runtime |
| `--model` | Model identifier to request |
| `--profile` | One of the four profiles |
| `--engine` | Selects the bounded-output field and reasoning states |
| `--engine-image` | Runtime image/binary reference, recorded as identity evidence |
| `--api-key-env` | Env var holding the runtime key (default `INFERENCE_API_KEY`); the key is never taken on argv |
| `--recipe` | Also emit portable recipe evidence for that recipe id |
| `--data-dir` | Directory holding `model-index.json` (default `$LOCAL_STUDIO_DATA_DIR` or `./data`) |
| `--list-profiles` | Print the profile catalog |
| `--compact` | Single-line JSON |

Exit status: `0` only for `OUTPUT_OK`, `1` for any other classification, `2`
for a usage error.

The probe issues exactly two requests — `GET /v1/models` and one bounded chat
completion. It does not load, stop, or download a model, change admission,
register a provider, or touch the instance store.

### Sample result — bounded output absorbed by reasoning

```json
{
  "runtime": {
    "base_url": "http://127.0.0.1:46865",
    "engine": "llamacpp",
    "engine_image": "ghcr.io/ggml-org/llama.cpp:server-rocm",
    "server_model_ids": ["Ternary-Bonsai-2-27B-PQ2_0"],
    "reachable": true
  },
  "model": {
    "requested": "Ternary-Bonsai-2-27B-PQ2_0",
    "served_as": "Ternary-Bonsai-2-27B-PQ2_0",
    "max_model_len": 32768,
    "matched": true
  },
  "request_profile": { "name": "short_reasoning", "max_output_tokens": 256, "reasoning_budget_tokens": 256, "...": "..." },
  "request": {
    "bounded_output_field": "max_tokens",
    "bounded_output_reason": "llamacpp reads the classic max_tokens bound.",
    "streamed": true,
    "body": {
      "model": "Ternary-Bonsai-2-27B-PQ2_0",
      "messages": [{ "role": "user", "content": "..." }],
      "max_tokens": 256,
      "temperature": 0,
      "top_p": 1,
      "stream": true,
      "stream_options": { "include_usage": true }
    }
  },
  "http": { "status": 200, "ok": true, "error": null, "abort_stage": null },
  "timing": { "ttft_ms": 9, "total_ms": 9, "generation_ms": 0, "tokens_per_second": null, "timed_tokens": 256 },
  "result": {
    "classification": "LENGTH_TRUNCATED",
    "finish_reason": "length",
    "content_length": 0,
    "reasoning_length": 32,
    "inlined_reasoning_length": 0,
    "completion_tokens": 256,
    "reasoning_tokens": 256,
    "reasoning_consumed_budget": true,
    "bounded_output_viable": false,
    "grounded_answer_match": false
  },
  "reasoning": {
    "budget": { "state": "SUPPORTED", "mechanism": "server_flag", "engine_flag": "--reasoning-budget", "applies_to_request": false, "...": "..." },
    "separation": { "state": "SUPPORTED", "engine_flag": "--reasoning-format", "...": "..." }
  },
  "evidence": [
    "finish_reason=length with 32 reasoning characters, so reasoning absorbed the output budget.",
    "llamacpp reads the classic max_tokens bound.",
    "reasoning budget state SUPPORTED: llama-server bounds reasoning with --reasoning-budget. The value is fixed when the server starts, so a request against an already-running runtime cannot change it."
  ]
}
```

## 8. Portable recipe evidence

`recipeEvidence()` in `controller/src/modules/diagnostics/evidence.ts` records
model path, served name, quantization, dtype, context, engine backend, runtime
kind and ref, the recommended bounded-output settings, the reasoning
configuration, and the known incompatibilities for that engine.

Known incompatibilities are properties of the **engine**, recorded as data. The
recorded set includes the recipe knobs that have no command-line spelling on
llama.cpp (tensor/pipeline parallel, memory fraction, KV dtype, dtype,
quantization), the absence of any budget flag on vLLM and SGLang, the absence
of reasoning flags on mlx_lm.server, and mlx's `max_model_len` → `--max-tokens`
spelling, which bounds output rather than context.

No evidence field encodes hardware placement. Statements like "this node always
uses X" belong to fleet inventory, not to a recipe.

## 9. Auto-router integration seam

Consumed as data. Nothing here calls `auto-router` or changes its state.

The export shape is `DiagnosticReport` from
`controller/contracts/inference-diagnostics.ts`, re-exported from
`controller/src/modules/diagnostics/index.ts`:

```json
{
  "runtime": { "base_url": "...", "engine": "llamacpp", "server_model_ids": ["..."], "reachable": true },
  "model": { "requested": "...", "served_as": "...", "max_model_len": 32768, "matched": true },
  "request_profile": { "name": "short_reasoning", "...": "..." },
  "http": { "status": 200, "ok": true, "error": null, "abort_stage": null },
  "timing": { "ttft_ms": 123, "total_ms": 3120, "generation_ms": 2997, "tokens_per_second": 14.2, "timed_tokens": 42 },
  "result": {
    "classification": "OUTPUT_OK",
    "finish_reason": "stop",
    "content_length": 4,
    "reasoning_length": 118,
    "inlined_reasoning_length": 0,
    "completion_tokens": 42,
    "reasoning_tokens": 30,
    "reasoning_consumed_budget": false,
    "bounded_output_viable": true,
    "grounded_answer_match": true
  },
  "reasoning": { "budget": { "...": "..." }, "separation": { "...": "..." } },
  "anatomy": { "...": "..." },
  "evidence": ["..."]
}
```

`request` echoes the exact body that was sent, including which bounded-output
field the engine was given. Without it a rejected request cannot be diagnosed
from the report alone — a runtime that 400s on `max_completion_tokens` looks
identical to one that 400s on a bad prompt. The body carries no credentials:
the API key travels in a header and is never part of the echoed payload.

`schema_version` is `"1"`. Consumers should treat unknown classifications and
unknown fields as forward-compatible additions.

`runQualificationProbe` fails with `DiagnosticProfileError` only for a malformed
profile; every other condition — including a runtime that is down, that refuses
the prompt, or that produces unusable output — is a **successful** Effect
carrying a classification. Consumers should branch on
`report.result.classification`, not on the Effect's success.

## 10. Authority boundaries preserved

Unchanged, and deliberately unreachable from this code: provider routing,
production admission, model automatic start/stop policy, deployment authority,
request-authority security, and agent dispatch. No controller route was added,
so no new public surface was created on the production controller. The probe
reads two HTTP endpoints and writes nothing.

## 11. Tests

`controller/test/diagnostics/` runs under `bun test`, wired into
`controller`'s `check`.

- `classification.test.ts` — normal answer; reasoning plus a final answer;
  reasoning absorbing the cap; reasoning-only; `finish_reason=length`; empty
  message; no chat choices; bare string body; inline thinking; multipart
  content; tool calls; first-token stall; generation overrun; unreachable
  runtime; 404 and 503; context refusal; a 400 that is not a context refusal.
- `reasoning-support.test.ts` — per-engine budget and separation states,
  invalid budgets, `IGNORED_BY_ENGINE` only where a directive was expected,
  profile bounds and node-name freedom, bounded-output field selection, request
  body shape, grounding as evidence only.
- `probe.test.ts` — the same classifications end to end against a real
  stalling server, so the first-token and generation deadlines are exercised
  through actual fetch and stream cancellation. Also covers a runtime that
  answers a streaming request with one JSON body, a catalog with no `data`
  array, inline monologue on a reasoning profile, properly separated reasoning,
  and tool calls streamed across frames.
- `evidence.test.ts` — reads recipes out of a real registry file, including the
  missing-file, unknown-id, empty-entries, and invalid-recipe paths; asserts the
  evidence shape carries no hardware placement; and pins that a recipe budget is
  judged against the recipe, not against the probe profile.

Run with `bun --cwd controller run test`.