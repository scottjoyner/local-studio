ARG ROCM_BASE_IMAGE=rocm/dev-ubuntu-24.04:7.2.1-complete@sha256:3db551c4e1229aac1857ac44fcb6141bb749f41348eb572452f11279153c13c3
FROM ${ROCM_BASE_IMAGE}

ARG PRISM_RELEASE=prism-b10709-9a9394a
ARG PRISM_COMMIT=9a9394a895b96003ca842a6041cb28ac49a108f7
ARG PRISM_ASSET=llama-prism-b10709-9a9394a-bin-ubuntu-rocm-7.2-x64.tar.gz
ARG PRISM_ASSET_SHA256=230f879d538bb9f794d25c908bc8c0f676774c41c3e70ea719131c86d899841d

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl findutils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  mkdir -p /opt/prism; \
  curl -fL --retry 3 \
    "https://github.com/PrismML-Eng/llama.cpp/releases/download/${PRISM_RELEASE}/${PRISM_ASSET}" \
    -o /tmp/prism-runtime.tar.gz; \
  printf '%s  %s\n' "${PRISM_ASSET_SHA256}" /tmp/prism-runtime.tar.gz | sha256sum -c -; \
  tar -xzf /tmp/prism-runtime.tar.gz -C /opt/prism; \
  rm -f /tmp/prism-runtime.tar.gz; \
  server="$(find /opt/prism -type f -name llama-server -print -quit)"; \
  test -n "$server"; \
  chmod 0755 "$server"; \
  printf '%s\n' "$server" > /opt/prism/llama-server.path

COPY packaging/r9700-bonsai2-rocm/omp-acquire.sh /opt/local-ai/omp-acquire
COPY packaging/r9700-bonsai2-rocm/entrypoint.sh /opt/local-ai/entrypoint
RUN chmod 0755 /opt/local-ai/omp-acquire /opt/local-ai/entrypoint

LABEL org.opencontainers.image.source="https://github.com/scottjoyner/local-studio"
LABEL ai.localstudio.hardware="radeon-ai-pro-r9700-32gb"
LABEL ai.localstudio.engine.repo="PrismML-Eng/llama.cpp"
LABEL ai.localstudio.engine.commit="9a9394a895b96003ca842a6041cb28ac49a108f7"
LABEL ai.localstudio.engine.release="prism-b10709-9a9394a"
LABEL ai.localstudio.engine.asset.sha256="230f879d538bb9f794d25c908bc8c0f676774c41c3e70ea719131c86d899841d"
LABEL ai.omarchy.model.repo="prism-ml/Ternary-Bonsai-2-27B-gguf"
LABEL ai.omarchy.model.revision="6ed5e12bf84b7a63069882c91dd9e9218647d17b"
LABEL ai.omarchy.model.quant="pq2_0+mmproj-q8_0"
LABEL ai.omarchy.hardware="radeon-ai-pro-r9700-32gb"
LABEL ai.omarchy.target_context_tokens="32768"

EXPOSE 8080
ENTRYPOINT ["/opt/local-ai/entrypoint"]
CMD ["--model", "/opt/models/Ternary-Bonsai-2-27B/Ternary-Bonsai-2-27B-PQ2_0.gguf", "--mmproj", "/opt/models/Ternary-Bonsai-2-27B/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf", "--alias", "Ternary-Bonsai-2-27B-PQ2_0", "--host", "0.0.0.0", "--port", "8080", "--ctx-size", "32768", "--n-gpu-layers", "999", "--flash-attn", "on", "--jinja", "--parallel", "1"]
