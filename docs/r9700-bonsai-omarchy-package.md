# R9700 Bonsai 2 ROCm package

This stacked lane turns the accepted Local Studio R9700/Bonsai evidence into an Omarchy-style portable candidate without changing validation authority.

The flow has three different receipts and they are intentionally not interchangeable:

1. The Local Studio acceptance bundle proves the exact R9700, Prism runtime, Bonsai artifacts, completion/tool behavior, benchmark, and OpenCode or Hermes session evidence.
2. The local image build receipt proves which clean Local Studio source revision produced a local Docker image ID. It is explicitly not publish authority.
3. The published-image receipt proves a digest-pinned registry manifest resolves to the exact local image config digest. Only this receipt may be used to add a registry draft launch.

The registry recipe remains status candidate and keeps its observed reference launch. The portable image is added only as draft_launch for the local-ai registry acceptance harness.

## Immutable inputs

The package pins:

- AMD ROCm Ubuntu 24.04 7.2.1 complete image by manifest digest:
  rocm/dev-ubuntu-24.04:7.2.1-complete@sha256:3db551c4e1229aac1857ac44fcb6141bb749f41348eb572452f11279153c13c3
- PrismML llama.cpp release prism-b10709-9a9394a at commit 9a9394a895b96003ca842a6041cb28ac49a108f7.
- Prism Linux ROCm 7.2 release archive SHA-256:
  230f879d538bb9f794d25c908bc8c0f676774c41c3e70ea719131c86d899841d
- Bonsai 2 model revision:
  6ed5e12bf84b7a63069882c91dd9e9218647d17b
- PQ2 model SHA-256:
  3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1
- Q8 projector SHA-256:
  6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903

The image exposes port 8080, keeps one parallel slot and a conservative 32K context to match the Local Studio acceptance lane, and expects AMD devices /dev/kfd and /dev/dri at runtime.

## 1. Produce physical R9700 evidence

Run the acceptance harness from the validation branch or a descendant:

    export OPENCODE_SESSION_ID=<existing-opencode-session>

or:

    export HERMES_SESSION_ID=<existing-hermes-session>

then:

    bash scripts/validate-bonsai2-r9700.sh

A successful run writes the Local Studio evidence bundle and the registry handoff. Nothing in the package lane can bypass candidatePromotable.

## 2. Build the candidate image

From a clean tracked checkout:

    bash scripts/build-r9700-bonsai2-rocm-image.sh

The default local tag is:

    local/r9700-bonsai2-rocm:candidate

The default build receipt is:

    packaging/r9700-bonsai2-rocm/build-receipt.json

That receipt records the source Git SHA, digest-pinned ROCm base, local Docker image ID, and publishable: false.

The build itself does not prove R9700 runtime acceptance and does not produce a registry manifest digest.

## 3. Push under an owned registry name

Choose a registry repository you control, tag the exact local image, and push it. For example:

    docker tag local/r9700-bonsai2-rocm:candidate ghcr.io/<owner>/r9700-bonsai2-rocm:candidate
    docker push ghcr.io/<owner>/r9700-bonsai2-rocm:candidate

Use the manifest digest reported by the registry to form an immutable reference:

    ghcr.io/<owner>/r9700-bonsai2-rocm@sha256:<64-hex-manifest-digest>

Do not pass the local Docker image ID here. A local image ID is the image config digest, not the published registry manifest digest.

## 4. Bind the published digest back to the build

Run:

    node scripts/record-r9700-bonsai2-published-image.mjs \
      --build-receipt packaging/r9700-bonsai2-rocm/build-receipt.json \
      --image ghcr.io/<owner>/r9700-bonsai2-rocm@sha256:<manifest-digest> \
      --output packaging/r9700-bonsai2-rocm/published-image-receipt.json

The recorder performs a remote docker buildx imagetools inspect. It requires a single-platform manifest and checks that its config digest exactly equals the localImageId in the build receipt. A tag-only reference, missing remote image, index without a direct config digest, or mismatched image is rejected.

## 5. Render the Omarchy/local-ai candidate

With the registry handoff from the physical acceptance run:

    node scripts/render-r9700-bonsai-omarchy-candidate.mjs \
      --registry-handoff ~/.local/share/local-studio/experimental/bonsai2-r9700/registry-handoff \
      --published-image-receipt packaging/r9700-bonsai2-rocm/published-image-receipt.json \
      --output-dir ./omarchy-handoff

The result mirrors the registry layout and adds a digest-pinned AMD ROCm draft_launch with:

- accelerator_backend amd-rocm;
- /dev/kfd and /dev/dri;
- port 8080;
- a persistent model-root mount;
- the exact published image manifest digest;
- build-source and published-receipt provenance.

It does not mark the recipe validated, recommended, or replace the observed Local Studio reference launch.

## 6. Run registry acceptance

Copy the generated registry tree into a current local-ai-registry checkout:

    cp -a omarchy-handoff/registry/. /path/to/local-ai-registry/registry/
    cd /path/to/local-ai-registry
    make index
    make check

Then run the registry's local-ai validate flow on the R9700 against the candidate recipe. Registry acceptance, not this renderer, is responsible for promoting draft_launch to launch and for any later recommended/Omarchy selection.

## Relationship to Omarchy PR 13036

The Omarchy local-AI flow consumes curated registry recipes keyed to exact hardware and launches digest-pinned containers. This package lane supplies the missing AMD/R9700 container candidate while preserving the same separation of concerns:

- Local Studio proves the exact physical runtime and agent behavior.
- The package receipt proves image provenance.
- local-ai-registry owns container acceptance and validated status.
- Omarchy consumes only what the registry has chosen to publish.

Hermes and OpenCode can both contribute session receipts; neither client becomes routing or publication authority.
