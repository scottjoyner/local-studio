# R9700 Bonsai registry handoff

This stacked follow-up converts an accepted Local Studio evidence bundle into a reviewable `local-ai-registry` candidate proposal. It does not publish to the registry and it never emits `status: validated`.

## Boundary

The input must be a `local-studio/local-ai-evidence/v1` bundle with:

- `summary.candidatePromotable === true`;
- exact Radeon AI PRO R9700 (`gfx1201`) acceptance;
- exact Bonsai 2 PQ2 model revision and file hash;
- exact PrismML llama.cpp runtime commit and binary hash;
- projector provenance;
- deterministic completion and structured tool-call proof;
- a clean Local Studio Git revision;
- at least one hashed OpenCode or Hermes session artifact; and
- accepted benchmark evidence.

The renderer independently re-checks the fixed hardware/model/runtime identifiers before producing output. A generic AMD receipt, older Bonsai PQ2 artifact, PTQ1 artifact, different PrismML runtime, or non-promotable evidence is rejected.

## Render the proposal

The one-command physical harness now renders the handoff automatically after—and only after—the acceptance receipt is promotable:

```bash
export OPENCODE_SESSION_ID=<existing-session-id>
bash scripts/validate-bonsai2-r9700.sh
```

By default it writes the handoff below `~/.local/share/local-studio/experimental/bonsai2-r9700/registry-handoff`. Override that with `LOCAL_STUDIO_BONSAI_REGISTRY_HANDOFF`.

You can also render an already accepted receipt directly:

```bash
node scripts/render-r9700-bonsai-registry-candidate.mjs \
  --evidence ~/.local/share/local-studio/experimental/bonsai2-r9700/r9700-bonsai2-acceptance.evidence.json \
  --output-dir ./registry-handoff
```

The output directory contains:

```text
registry-handoff/
├── handoff-manifest.json
└── registry/
    ├── model-instance/
    │   └── prism-ml-ternary-bonsai-2-27b-gguf--pq2-0.json
    └── recipe/
        └── llamacpp-bonsai2-pq2-radeon-ai-pro-r9700-32gb-tp1.json
```

The model-instance is new because the registry's existing Bonsai 2 record is PTQ1, while older PQ2 records point at the pre-Bonsai-2 repository/revision. The proposed model-instance therefore preserves the exact Bonsai 2 repository `prism-ml/Ternary-Bonsai-2-27B-gguf`, revision `6ed5e12bf84b7a63069882c91dd9e9218647d17b`, and accepted PQ2 artifact instead of borrowing incompatible provenance.

The recipe targets the registry's existing hardware id `radeon-ai-pro-r9700-32gb`. Chat and tool capabilities are carried as proven. Reasoning and vision remain `null` until separately accepted, even though a projector is pinned and the model is intended to support those capabilities.

## Privacy and provenance

The registry proposal includes SHA-256 receipts, artifact basenames, benchmark results, agent type, Local Studio source revision, and the source evidence digest. It intentionally omits machine-local absolute paths and does not copy OpenCode/Hermes session contents.

The generated recipe remains a candidate. Registry maintainers can review the evidence and decide how to package a portable launch contract; Local Studio's accepted local binary path is recorded as provenance, not presented as a portable registry launch.

Before opening the downstream registry PR, copy or overlay `registry-handoff/registry/` onto the `registry/` directory of a current `0xSero/local-ai-registry` checkout, run `make index && make check`, and include the original Local Studio evidence receipt or its immutable location in the review context. The handoff manifest is provenance for that transfer; it is not itself a registry record.

```bash
cp -a registry-handoff/registry/. /path/to/local-ai-registry/registry/
cd /path/to/local-ai-registry
make index
make check
```

## Contract test

The stacked CI runs:

```bash
node scripts/render-r9700-bonsai-registry-candidate.test.mjs
```

The test proves that promotable evidence generates linked model-instance/recipe records without leaking local paths, and that non-promotable evidence is rejected.
