#!/bin/sh
set -eu

/opt/local-ai/omp-acquire

server="$(cat /opt/prism/llama-server.path)"
if [ ! -x "$server" ]; then
  printf '%s\n' "local-ai: pinned Prism llama-server is missing or not executable" >&2
  exit 2
fi

exec "$server" "$@"
