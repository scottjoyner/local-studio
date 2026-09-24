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
