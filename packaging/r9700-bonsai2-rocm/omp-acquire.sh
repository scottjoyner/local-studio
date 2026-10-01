#!/bin/sh
set -eu

repo="prism-ml/Ternary-Bonsai-2-27B-gguf"
revision="6ed5e12bf84b7a63069882c91dd9e9218647d17b"
root="${LOCAL_AI_MODEL_ROOT:-/opt/models/Ternary-Bonsai-2-27B}"
model="Ternary-Bonsai-2-27B-PQ2_0.gguf"
model_sha="3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1"
projector="Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf"
projector_sha="6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903"
endpoint="${HF_ENDPOINT:-https://huggingface.co}"
timeout="${LOCAL_AI_ACQUIRE_TIMEOUT:-1800}"
marker="$root/.local-ai-ready"

mkdir -p "$root"

good() {
  file="$1"
  expected="$2"
  [ -f "$file" ] || return 1
  printf '%s  %s\n' "$expected" "$file" | sha256sum -c - >/dev/null 2>&1
}

fetch() {
  name="$1"
  expected="$2"
  destination="$root/$name"
  if good "$destination" "$expected"; then
    return 0
  fi
  rm -f "$destination" "$destination.part"
  curl -fL --retry 3 --max-time "$timeout" \
    "$endpoint/$repo/resolve/$revision/$name" \
    -o "$destination.part"
  printf '%s  %s\n' "$expected" "$destination.part" | sha256sum -c -
  mv "$destination.part" "$destination"
}

if good "$root/$model" "$model_sha" && good "$root/$projector" "$projector_sha"; then
  printf '%s\n' "$revision" > "$marker"
  exit 0
fi

rm -f "$marker"
fetch "$model" "$model_sha"
fetch "$projector" "$projector_sha"
printf '%s\n' "$revision" > "$marker"
