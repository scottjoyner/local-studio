import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
] as const;

type Manifest = {
  schema: "local-studio-agent-runtime-provenance-v1";
  git_head: string | null;
  source_clean: boolean;
  files: Record<string, string>;
};

export type AgentRuntimeProvenance = Manifest & {
  mode: "built" | "source" | "unverified";
  started_at: string;
  manifest_sha256: string;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filepath: string): string {
  return sha256(readFileSync(filepath));
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function sourceManifest(): Manifest {
  try {
    const repoRoot = git(import.meta.dirname, ["rev-parse", "--show-toplevel"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]);
    const status = execFileSync(
      "git",
      ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const files = Object.fromEntries(
      TRACKED_FILES.map((relativePath) => [
        relativePath,
        sha256File(path.join(repoRoot, relativePath)),
      ]),
    );
    return {
      schema: "local-studio-agent-runtime-provenance-v1",
      git_head: /^[0-9a-f]{40}$/.test(head) ? head : null,
      source_clean: status.trim() === "",
      files,
    };
  } catch {
    return {
      schema: "local-studio-agent-runtime-provenance-v1",
      git_head: null,
      source_clean: false,
      files: {},
    };
  }
}

function loadStartupProvenance(): AgentRuntimeProvenance {
  const startedAt = new Date().toISOString();
  const builtManifestPath = path.resolve(
    import.meta.dirname,
    "../../../runtime-provenance.json",
  );

  if (existsSync(builtManifestPath)) {
    try {
      const raw = readFileSync(builtManifestPath);
      const parsed = JSON.parse(raw.toString("utf8")) as Manifest;
      if (
        parsed.schema === "local-studio-agent-runtime-provenance-v1" &&
        typeof parsed.source_clean === "boolean" &&
        parsed.files !== null &&
        typeof parsed.files === "object"
      ) {
        return Object.freeze({
          ...parsed,
          mode: "built" as const,
          started_at: startedAt,
          manifest_sha256: sha256(raw),
        });
      }
    } catch {}
    return Object.freeze({
      schema: "local-studio-agent-runtime-provenance-v1",
      git_head: null,
      source_clean: false,
      files: {},
      mode: "unverified" as const,
      started_at: startedAt,
      manifest_sha256: sha256("invalid-built-runtime-provenance"),
    });
  }

  const manifest = sourceManifest();
  return Object.freeze({
    ...manifest,
    mode: manifest.git_head ? ("source" as const) : ("unverified" as const),
    started_at: startedAt,
    manifest_sha256: sha256(JSON.stringify(manifest)),
  });
}

export const AGENT_RUNTIME_PROVENANCE = loadStartupProvenance();
