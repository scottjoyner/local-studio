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
    "harness_id": "chrn-system-one",
    "hermes_system_one": {
      "profile": "hermes-system-one-heartbeat-v1",
      "uhp_version": "2026-09-12",
      "receipt_id": "heartbeat-example",
      "observed_at": "2026-09-23T23:00:00Z",
      "expires_at": "2026-09-23T23:10:00Z",
      "advice": {
        "mode": "act",
        "mode_confidence": 0.91,
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
        "fleet_projection_checksum": "checksum"
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

The default maximum receipt TTL is 900 seconds. It can be reduced or raised with
`LOCAL_STUDIO_SYSTEM_ONE_MAX_TTL_SECONDS`, capped at 3600 seconds.

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
- any authority extension is `true`
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

It produces a SHA-pinned manifest plus five response files:

| file | expected Local Studio result |
| --- | --- |
| `valid.json` | consumed |
| `expired.json` | ignored: `expired` |
| `authority-bearing.json` | ignored: `authority_mutation_allowed` |
| `model-fallback.json` | ignored: `model_fallback` |
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
- the project fingerprint equals the current resolved workspace
- both binding hashes are valid lowercase SHA-256 values

This means a fresh valid response generated for another Pi session or workspace
is still rejected.

After all validation passes, Local Studio atomically writes a consumption marker
under:

`<LOCAL_STUDIO_DATA_DIR>/system-one/consumed/`

before prompt injection. The same response cannot be injected twice into the
same Pi session, including after process restart. Re-presentation is logged as:

`replay_already_consumed`

A marker-write failure also fails closed and injects nothing.

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
