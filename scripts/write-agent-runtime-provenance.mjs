#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRACKED_FILES = [
  "services/agent-runtime/src/runtime-provenance.ts",
  "services/agent-runtime/src/system-one-advisory.ts",
  "services/agent-runtime/src/system-one-signature.ts",
  "services/agent-runtime/src/pi-runtime.ts",
  "services/agent-runtime/src/pi-runtime-types.ts",
  "services/agent-runtime/src/http/handlers.ts",
  "services/agent-runtime/src/server.ts",
  "services/agent-runtime/package.json",
  "services/agent-runtime/bun.lock",
];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(head)) {
  throw new Error("Could not resolve exact Local Studio Git HEAD");
}
const status = execFileSync(
  "git",
  ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
  { encoding: "utf8" },
);
const files = Object.fromEntries(
  TRACKED_FILES.map((relativePath) => [
    relativePath,
    sha256File(join(repoRoot, relativePath)),
  ]),
);
const manifest = {
  schema: "local-studio-agent-runtime-provenance-v1",
  git_head: head,
  source_clean: status.trim() === "",
  files,
};
const out = join(repoRoot, "services", "agent-runtime", "dist", "runtime-provenance.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
process.stdout.write(
  `[agent-runtime] wrote provenance for ${head} (${manifest.source_clean ? "clean" : "dirty"})\n`,
);
