# System-One advisory context

Local Studio can consume a completed System-One advisory result before each Pi coding-agent turn.

This integration is intentionally advisory. It does not change Local Studio's selected model, active
tools, project workspace, provider credentials, controller routing, or any Hermes/AssistX claim,
approval, mutation, or runtime-admission decision.

## Protocol envelope

The file is a stored Unified Harness Protocol response with a private metadata profile:

```json
{
  "id": "resp_example",
  "object": "response",
  "status": "completed",
  "previous_response_id": null,
  "model": "my-jev/system-one",
  "output": [],
  "metadata": {
    "session_id": "hsess-example",
    "harness_id": "chrn_system_one",
    "hermes_system_one": {
      "profile": "hermes-system-one-heartbeat-v1",
      "uhp_version": "2026-09-12",
      "contract_sha256": "5e88c73e7cbb2e46f3b5171951d2a84f0549633fbcb420458d56ae5ada0ffc8f",
      "receipt_id": "heartbeat-example",
      "observed_at": "2026-09-23T23:00:00Z",
      "expires_at": "2026-09-23T23:10:00Z",
      "advice": {
        "mode": "act",
        "mode_confidence": 0.91,
        "policy_disposition": "propose_action",
        "approval_recommended": true,
        "task_focus": "Continue the bounded implementation already in progress.",
        "context_priority": ["current-pr", "latest-handoff"],
        "fleet_priority": [
          {
            "handle": "eligible:opaque:1",
            "score": 0.88,
            "reason": "Highest score among the already-eligible handles."
          }
        ]
      },
      "authority": {
        "dispatch_allowed": false,
        "approval_granted": false,
        "claim_acquired": false,
        "mutation_allowed": false,
        "routing_authority_changed": false
      },
      "provenance": {
        "system_one_config_version": "v1",
        "model_revision": "exact-model-revision",
        "knowledge_revision": "exact-knowledge-revision",
        "neo4j_snapshot_id": "snapshot-id",
        "fleet_projection_generation": "generation",
        "fleet_projection_checksum": "checksum",
        "trace_sha256": "<64 lowercase hex or null>"
      }
    }
  }
}
```

The consumer rejects the response unless it is completed, fresh, bounded, explicitly non-authoritative,
and free of model fallback/substitution.

## File resolution

For Pi session `<session-id>`, the runtime checks the first existing path in this order:

1. `LOCAL_STUDIO_SYSTEM_ONE_ADVISORY_PATH` when explicitly configured
2. `<LOCAL_STUDIO_DATA_DIR>/system-one/sessions/<session-id>.json`
3. `<LOCAL_STUDIO_DATA_DIR>/system-one/latest.json`

No network request occurs from the turn hook.

The contract maximum receipt TTL is 900 seconds. It can be reduced with
`LOCAL_STUDIO_SYSTEM_ONE_MAX_TTL_SECONDS`, but configuration cannot widen it
above 900 seconds.

## Fail-closed rules

The advisory is ignored when any of these are true:

- JSON is malformed
- the object is not a UHP response
- response status is not `completed`
- response/session/harness identity is missing or malformed
- the Hermes profile version is unknown
- the receipt is expired, from the future beyond clock skew, or has an excessive TTL
- the mode is unknown or confidence is outside `[0,1]`
- context or fleet ranking exceeds its bound
- an opaque fleet handle is malformed or duplicated
- any required authority field is not exactly `false`
- the profile, binding, advice, authority, fleet item, or provenance objects contain fields outside the pinned schema
- an `incomplete` System-One response carries a refusal/escalation handoff; the handoff is recorded as ignored evidence and is not injected as completed advice
- UHP metadata reports model fallback/substitution

There is no fallback to `act`, another model, another receipt, a direct endpoint, or Agent Auto.

## Turn behavior

A valid receipt is appended to the system prompt under the marker:

`Local Studio System-One advisory:`

The section explicitly tells the coding agent that the data is advisory only and that opaque fleet
handles are not endpoints or dispatch grants.

The hook does not call `setActiveToolsByName`, mutate the model selection, change cwd, modify request
authority, or invoke a tool.

## Evidence

Every consumed receipt appends one line to:

`<LOCAL_STUDIO_DATA_DIR>/system-one/consumption.jsonl`

The line records:

- Local Studio Pi session id
- UHP protocol/profile version
- UHP response id
- UHP session id
- configured harness id
- previous response id
- Hermes receipt id
- SHA-256 of the stored response bytes
- SHA-256 of the advisory profile
- actually served model
- recommended mode and confidence
- opaque ranked fleet handles
- the explicit all-false authority assertion

An existing but rejected advisory also appends an `ignored` record with a bounded reason code and
stored-response hash when available.

## Intended producer

The preferred producer is a configured SystemOneHarness instance exposed through UHP.

Its state should be projected host-side from bounded read-only inputs:

- current Hermes/AssistX work state
- relevant Neo4j knowledge and memory facts
- current Git-versioned Markdown/Obsidian knowledge state
- fresh fleet observations
- the canonical signed runtime projection
- already-authoritative eligibility and claim/reservation facts

The advisory harness itself should not receive mutation-capable MCP servers or direct fleet dispatch
tools.

## Acceptance checklist

Before using learned advice, verify with deterministic/recorded responses that:

- a valid fresh response appears on the next agent turn
- an expired response is absent from the turn
- an authority-bearing response is absent from the turn
- a response carrying model fallback is absent from the turn
- the existing Local Studio active tool list is unchanged
- the selected Local Studio model is unchanged
- project cwd is unchanged
- no controller/routing mutation occurs
- the consumption ledger names the exact response, session and receipt hashes

After this contract is stable, my-jev and later Bonsai decision providers can sit behind the same UHP
profile without changing Local Studio.


## Cross-repo deterministic acceptance

The matching producer fixture suite lives in `scottjoyner/my-jev#2`.

After installing that branch, render all consumer-boundary cases:

```bash
my-jev-uhp-fixture-suite \
  --output-dir /tmp/system-one-acceptance \
  --consumer-session-id '<active-pi-session-id>' \
  --project-cwd /absolute/path/to/current/project \
  --snapshot-sha256 '<64-char-snapshot-sha256>'
```

It produces a SHA-pinned manifest plus eight response files:

| file | expected Local Studio result |
| --- | --- |
| `valid.json` | consumed |
| `expired.json` | ignored: `expired` |
| `authority-bearing.json` | ignored: `authority_mutation_allowed` |
| `model-fallback.json` | ignored: `model_fallback` |
| `wrong-session.json` | ignored: `binding_session_mismatch` |
| `wrong-project.json` | ignored: `binding_project_mismatch` |
| `wrong-contract.json` | ignored: `contract_mismatch` |
| `handoff.json` | ignored: `system_one_handoff` |

For each case:

```bash
export LOCAL_STUDIO_SYSTEM_ONE_ADVISORY_PATH=/tmp/system-one-acceptance/<case>.json
```

Then run one ordinary coding-agent turn and inspect:

```text
<LOCAL_STUDIO_DATA_DIR>/system-one/consumption.jsonl
```

Only the valid case may add the `Local Studio System-One advisory:` system
context. Invalid or handoff cases must inject nothing and append an ignored
evidence record with the expected reason.

This acceptance pass does not require a learned model, a fleet dispatch, a
Neo4j mutation, or a live HarnessRouter deployment.


## Receipt binding and single-use replay defense

The canonical producer contract is pinned by SHA-256:

`5e88c73e7cbb2e46f3b5171951d2a84f0549633fbcb420458d56ae5ada0ffc8f`

Local Studio rejects a response when `metadata.hermes_system_one.contract_sha256`
does not exactly match that contract.

A valid receipt must carry:

```json
{
  "binding": {
    "consumer": "local-studio",
    "work_id": "work-...",
    "consumer_session_id": "<exact active Pi session id>",
    "project_fingerprint": "<sha256(canonical realpath workspace)>",
    "snapshot_sha256": "<exact source heartbeat snapshot sha256>"
  }
}
```

Before injection Local Studio verifies:

- `consumer == local-studio`
- the consumer session id equals the canonical active Pi session
- the project fingerprint equals the current canonical realpath workspace
- the configured UHP harness id equals `LOCAL_STUDIO_SYSTEM_ONE_HARNESS_ID` (default `chrn_system_one`)
- both binding hashes are valid lowercase SHA-256 values

`work_id` and `snapshot_sha256` are source-lineage fields at the Local Studio boundary. Local
Studio validates their shape and records them, but it does not have the producer's source work graph
or heartbeat snapshot available to independently recompute them. The my-jev compiler is responsible
for matching `snapshot_sha256` to the exact source snapshot. For authenticated runs, my-jev now
signs the **exact stored UHP response bytes** with a detached Ed25519 signature. Local Studio
verifies that signature before validation/injection, so the bound work/session/project/snapshot
lineage travels inside producer-authenticated response bytes rather than relying only on a
self-reported hash.

This means a fresh valid response generated for another Pi session or workspace
is still rejected.

After all validation passes, Local Studio atomically writes a consumption marker
under:

`<LOCAL_STUDIO_DATA_DIR>/system-one/consumed/`

before prompt injection. Replay identity is keyed by receipt id within the target
Pi session rather than raw JSON bytes, so reformatting or re-wrapping a receipt
does not reset single-use state. Re-presentation is logged as:

`replay_already_consumed`

If the same receipt id reappears with different response/profile content it is rejected as
`receipt_id_conflict`. A marker-write failure also fails closed and injects nothing.

A successful advisory is injected only after both the atomic single-use marker and the detailed
JSONL consumption record are durably written. If the detailed ledger cannot persist, the receipt is
burned and the turn receives no advisory.

The consumption ledger now preserves the binding, contract hash, response hash,
profile hash, served model, richer policy disposition, and advisory approval
recommendation.

## Expanded deterministic acceptance suite

The matching `my-jev#2` fixture suite now includes:

- valid -> consumed
- expired -> ignored
- authority-bearing -> ignored
- model fallback -> ignored
- wrong session -> `binding_session_mismatch`
- wrong project -> `binding_project_mismatch`
- wrong contract -> `contract_mismatch`
- System-One refusal/escalation -> `system_one_handoff`

A valid response consumed a second time should produce
`replay_already_consumed`.


## Producer and consumer evidence authenticity

The hardened path uses two deliberately separate Ed25519 trust domains.

### Producer response key

my-jev signs the exact stored UHP response bytes with:

- schema: `hermes-system-one-detached-signature-v1`
- domain: `hermes-system-one-uhp-response-bytes-ed25519-v1`
- preimage: `domain || NUL || exact stored response bytes`

The signature sidecar records the response SHA-256, preimage SHA-256, and an
`ed25519:<sha256(SPKI DER)>` key id.

Local Studio verifies the raw bytes before parsing the advisory. A configured
public key makes signatures mandatory; unsigned downgrade, wrong key id,
malformed envelope, non-canonical base64, response-byte drift, and invalid
Ed25519 signatures all fail closed.

For a separately pinned live trust anchor configure:

```bash
export LOCAL_STUDIO_SYSTEM_ONE_REQUIRE_SIGNATURE=true
export LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH=/secure/producer-public.pem
export LOCAL_STUDIO_SYSTEM_ONE_EXPECTED_KEY_ID='ed25519:<sha256-spki-der>'
```

The public key must be a bounded regular non-symlink file and must not be
group/other writable on POSIX. The expected key-id pin detects replacement of
the key file with another valid Ed25519 key.

### Consumer evidence key

The Local Studio acceptance harness can separately sign the exact retained
acceptance-report bytes with:

- schema: `local-studio-system-one-acceptance-signature-v1`
- domain: `local-studio-system-one-acceptance-report-bytes-ed25519-v1`
- preimage: `domain || NUL || exact report bytes`

This key authenticates the consumer-side causal evidence: runtime provenance,
ledger checkpoint hash, consume-marker hash, fixture/signature hashes,
before/after state, replay evidence, and the producer evidence embedded in the
report.

The producer key and consumer-evidence key **must be distinct**. Reusing one key
for both trust domains is rejected.

Private signing keys are loaded only when needed, must be regular non-symlink
files, and must not be accessible to group/other on POSIX. The Local Studio
consumer-evidence private key is intentionally loaded only after all runtime
interaction has finished.

The offline verifier requires public verification material plus separately
pinned expected key ids. Supplying a trust anchor makes the corresponding
signature mandatory; deleting signature files cannot downgrade the bundle to
unsigned verification.

## One-turn causal acceptance evidence

The consumer records three additional append-only evidence stages for a consumed
advisory. These are observational only; they do not expose a new runtime API or
change model, tool, routing, approval, claim, or mutation state.

1. `turn_boundary_captured`
   - exact selected Local Studio model id
   - provider id and backend model id
   - canonical cwd fingerprint
   - active Pi tool names and their canonical SHA-256
   - the same explicit all-false authority assertion
2. `provider_request_observed`
   - SHA-256 of the outbound provider payload, never the payload itself
   - whether the advisory marker, response id, and receipt id are present
   - observed provider model and expected backend model
   - observed provider tool declarations and whether they match the active Pi tools
3. `turn_completed`
   - selected model before/after and an equality assertion
   - provider/backend route before/after and an equality assertion
   - cwd fingerprint before/after and an equality assertion
   - provider-request count and passive tool-call count
   - whether the advisory `task_focus` value appeared in the agent messages
   - SHA-256 of the rendered assistant text plus an exact `task_focus` equality assertion
   - the unchanged all-false authority assertion

The smallest causal acceptance uses a unique canary only in
`metadata.hermes_system_one.advice.task_focus`, then asks one read-only coding
turn to return that value exactly without using tools.

For that turn, the evidence package passes only when all of the following hold:

- the consumed response id and receipt id are the intended exact fixture
- `advisory_marker_present == true`
- `response_id_present == true`
- `receipt_id_present == true`
- `provider_model_matches_expected == true`
- `provider_tools_match_active == true`
- `task_focus_observed_in_agent_messages == true`
- `task_focus_echo_exact == true`
- `assistant_text_sha256 == sha256(task_focus canary)`
- `selected_model_unchanged == true`
- `provider_route_unchanged == true`
- `cwd_unchanged == true`
- `tool_call_count == 0`
- every authority field remains exactly `false`

This is the narrow proof that a stored UHP response influenced one provider-bound
coding-agent turn while the existing Local Studio execution boundary stayed
unchanged. It does not require a learned System-One model, fleet dispatch,
runtime admission, claim mutation, approval grant, or Neo4j write.

### Operator harness

Run the agent runtime with an isolated `LOCAL_STUDIO_DATA_DIR`, then execute:

```bash
node scripts/system-one-one-turn-acceptance.mjs \
  --model '<existing Local Studio coding model id>' \
  --cwd /absolute/path/to/project \
  --data-dir /tmp/local-studio-uhp-acceptance \
  --my-jev-repo /absolute/path/to/my-jev \
  --snapshot-sha256 '<exact heartbeat snapshot sha256>'
```

The default `--producer fixture` mode is the smallest consumer-boundary proof.
It uses my-jev's deterministic recorded UHP fixture and proves that the stored
response reaches one provider-bound coding-agent turn without changing Local
Studio's model, tool, cwd, or authority boundary.

For the full deterministic producer + consumer chain, use the HarnessRouter
scripted producer:

```bash
node scripts/system-one-one-turn-acceptance.mjs \
  --producer harnessrouter-script \
  --model '<existing Local Studio coding model id>' \
  --cwd /absolute/path/to/project \
  --data-dir /tmp/local-studio-uhp-acceptance \
  --my-jev-repo /absolute/path/to/my-jev \
  --python /absolute/path/to/my-jev-python \
  --snapshot /tmp/hermes-heartbeat.json \
  --snapshot-sha256 '<exact heartbeat snapshot sha256>' \
  --harnessrouter-repo /absolute/path/to/harnessrouter \
  --harnessrouter-python /absolute/path/to/harnessrouter-python \
  --producer-signing-key /secure/producer-private.pem \
  --expected-producer-key-id 'ed25519:<producer-spki-sha256>' \
  --evidence-signing-key /secure/local-studio-evidence-private.pem \
  --expected-evidence-key-id 'ed25519:<evidence-spki-sha256>'
```

The runtime under test must use the same isolated
`LOCAL_STUDIO_DATA_DIR=/tmp/local-studio-uhp-acceptance`. The heartbeat
snapshot must be fresh and its supplied SHA-256 must match the producer probe.

For `harnessrouter-script`, both Python executables must be absolute paths.
Local Studio launches my-jev with Python isolated mode (`-I`), an explicit
exact-head source path, and a sanitized environment that removes ambient
`PYTHON*`, `LD_*`, `DYLD_*`, OpenRouter, and TypeSafe provider variables.
CI attacks this boundary with a hostile `sitecustomize.py` and environment
sentinels.

In `harnessrouter-script` mode the harness first establishes the canonical Pi
session, then calls `my-jev-harnessrouter-probe`. That probe requires
`HarnessRouter/harnessrouter@250de65d6e690abdef40e39d21591b4a807984a3`,
runs the parameterized System-One scripted provider with no provider network
call, verifies the terminal recommendation and trace, compiles the bound UHP
response, and returns it to this consumer acceptance.

The final report records `producer_mode` and embeds the producer evidence. The
producer sub-report and trace are retained beneath:

`<LOCAL_STUDIO_DATA_DIR>/system-one/producer/<response-id>/`

so the deterministic chain can be audited as one evidence package:

`heartbeat snapshot -> finite MCP -> HarnessRouter scripted System-One -> recommendation -> bound UHP response -> one Local Studio coding turn`.

### Independent offline evidence verification

Do not treat the acceptance process's own `verdict: pass` as the final proof.

`scripts/verify-system-one-evidence.mjs` independently reopens the retained
fixture, consumer report, replay rows, and (for `harnessrouter-script`) the
producer recommendation, trace, producer report, and stored response. It
recomputes raw file hashes and cross-checks the critical identifiers and
authority invariants without trusting the original report's `assertions`
object.

Run it against a retained bundle:

```bash
node scripts/verify-system-one-evidence.mjs \
  --report /tmp/local-studio-uhp-acceptance/system-one/acceptance/<response-id>.json \
  --expected-local-head '<exact Local Studio SHA>' \
  --expected-my-jev-head '<exact my-jev SHA>' \
  --producer-public-key /secure/producer-public.pem \
  --expected-producer-key-id 'ed25519:<producer-spki-sha256>' \
  --evidence-public-key /secure/local-studio-evidence-public.pem \
  --expected-evidence-key-id 'ed25519:<evidence-spki-sha256>' \
  --output /tmp/local-studio-uhp-acceptance/system-one/acceptance/<response-id>.verified.json
```

The verifier derives the bound fixture and producer bundle from the
`system-one` directory instead of trusting capture-time absolute paths, so a
retained directory can be moved or restored before verification.

It independently requires, among other checks:

- exact contract, receipt, session, project, and snapshot binding
- raw fixture hash equality with the consumed ledger row
- exactly one consumed/boundary/provider/completion evidence row
- provider marker/response/receipt presence and a provider-request hash
- read-only tool set, one provider request, and zero tool calls
- exact latest-assistant canary hash/equality
- unchanged model, route, cwd, and Pi session
- exactly one `replay_already_consumed` row and no replay influence rows
- for HarnessRouter mode, raw recommendation/trace/stored-response hashes,
  pinned HarnessRouter head, one terminal `recommend` step, config v1,
  all-false authority, trace binding, and `script/s1` with no fallback

CI runs dependency-free adversarial self-tests that verify a coherent retained
bundle, then attack assistant-output evidence, producer mode, source snapshot,
detached producer signature, consumer-report signature, stripped signatures,
symlink/path containment, mutable public-key trust anchors, reviewed Git heads,
runtime provenance, post-checkpoint ledger appends, and ambient Python startup
injection.

The harness deliberately uses three phases:

1. a bootstrap prompt with no advisory present, solely to establish the canonical
   Pi session id that the receipt must bind to
2. exactly one read-only **influenced acceptance turn** after generating the
   bound my-jev fixture into `system-one/sessions/<pi-session-id>.json`
3. one read-only replay control that re-presents that exact receipt and must log
   `replay_already_consumed` without producing any consumed, boundary,
   provider-request, or completed advisory-influence evidence rows

The replay control is not a second influenced turn; its purpose is to prove the
same semantic receipt cannot affect another turn.

It refuses to proceed when `system-one/latest.json` exists or the bootstrap
produces any System-One ledger record, so unrelated advice cannot contaminate
the proof.

The generated report is written to:

`<LOCAL_STUDIO_DATA_DIR>/system-one/acceptance/<response-id>.json`

and contains the exact Local Studio and my-jev Git heads, source snapshot hash,
raw fixture hash, producer canonical hashes, before/after runtime status,
assertion results, and the append-only ledger rows for that response. A failed
assertion returns a non-zero exit status.


### Scope of the operator proof

This operator harness is a consumer-boundary proof. It deliberately uses
`my_jev.uhp_fixture`; it does **not** prove the full
`heartbeat snapshot -> System-One recommendation -> recommendation compiler`
producer chain. That producer chain has its own deterministic compiler tests and
must get a separate HarnessRouter scripted-provider acceptance before the two
evidence packages are treated as one end-to-end proof.


### Cross-language hash caveat

The acceptance report intentionally does not compare my-jev's ad-hoc canonical
profile SHA-256 to Local Studio's ad-hoc canonical profile SHA-256. Python and
JavaScript can serialize semantically equal JSON numbers differently (for
example `1.0` versus `1`).

The deterministic HarnessRouter path compares the exact stored-response bytes
copied from the producer with the raw response hash observed by the consumer,
and the authenticated path now adds a detached Ed25519 signature over those
**exact bytes**. This deliberately avoids assuming Python and JavaScript
language-local canonical JSON hashes are interchangeable.
