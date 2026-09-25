#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  requireAbsolutePythonForTrustedProducer,
  runIsolatedPythonModule,
} from "./system-one-python-launch.mjs";

function pythonExecutable() {
  const probe = spawnSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    throw new Error("python3 is required for producer isolation CI");
  }
  const value = probe.stdout.trim();
  if (!isAbsolute(value)) {
    throw new Error("python3 did not resolve to an absolute executable");
  }
  return value;
}

const root = mkdtempSync(join(tmpdir(), "local-studio-python-isolation-"));
const original = {
  PYTHONPATH: process.env.PYTHONPATH,
  PYTHONSTARTUP: process.env.PYTHONSTARTUP,
  LD_SYSTEM_ONE_SENTINEL: process.env.LD_SYSTEM_ONE_SENTINEL,
  DYLD_SYSTEM_ONE_SENTINEL: process.env.DYLD_SYSTEM_ONE_SENTINEL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
};

try {
  const repoRoot = join(root, "repo");
  const packageRoot = join(repoRoot, "src", "probe_pkg");
  const ambient = join(root, "ambient");
  const resultPath = join(root, "result.json");
  const siteMarker = join(root, "sitecustomize-ran");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(ambient, { recursive: true });

  writeFileSync(
    join(ambient, "sitecustomize.py"),
    [
      "import os, pathlib",
      "marker = os.environ.get('SYSTEM_ONE_SITECUSTOMIZE_MARKER')",
      "if marker:",
      "    pathlib.Path(marker).write_text('ambient startup executed', encoding='utf-8')",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(packageRoot, "__main__.py"),
    [
      "import json, os, pathlib, sys",
      "path = pathlib.Path(sys.argv[1])",
      "path.write_text(json.dumps({",
      "  'isolated': bool(sys.flags.isolated),",
      "  'ignore_environment': bool(sys.flags.ignore_environment),",
      "  'pythonpath': os.environ.get('PYTHONPATH'),",
      "  'pythonstartup': os.environ.get('PYTHONSTARTUP'),",
      "  'ld_sentinel': os.environ.get('LD_SYSTEM_ONE_SENTINEL'),",
      "  'dyld_sentinel': os.environ.get('DYLD_SYSTEM_ONE_SENTINEL'),",
      "  'openrouter_key': os.environ.get('OPENROUTER_API_KEY'),",
      "  'typesafe_key': os.environ.get('TYPESAFE_API_KEY'),",
      "  'source_first': sys.path[0],",
      "}), encoding='utf-8')",
      "",
    ].join("\n"),
    "utf8",
  );

  process.env.PYTHONPATH = ambient;
  process.env.PYTHONSTARTUP = join(ambient, "startup.py");
  process.env.LD_SYSTEM_ONE_SENTINEL = "must-not-reach-python";
  process.env.DYLD_SYSTEM_ONE_SENTINEL = "must-not-reach-python";
  process.env.OPENROUTER_API_KEY = "must-not-reach-python";
  process.env.TYPESAFE_API_KEY = "must-not-reach-python";
  process.env.SYSTEM_ONE_SITECUSTOMIZE_MARKER = siteMarker;

  const python = pythonExecutable();
  requireAbsolutePythonForTrustedProducer(python, "test python");
  let rejectedRelative = false;
  try {
    requireAbsolutePythonForTrustedProducer("python3", "test python");
  } catch {
    rejectedRelative = true;
  }
  if (!rejectedRelative) {
    throw new Error("Trusted producer accepted a relative Python executable");
  }

  const run = runIsolatedPythonModule({
    python,
    repoRoot,
    module: "probe_pkg",
    argv: [resultPath],
  });
  if (run.status !== 0) {
    throw new Error(
      "Isolated Python module failed:\n" + (run.stderr || run.stdout),
    );
  }
  if (existsSync(siteMarker)) {
    throw new Error("Ambient sitecustomize executed inside producer process");
  }

  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.isolated !== true || result.ignore_environment !== true) {
    throw new Error("Producer Python did not run in isolated environment mode");
  }
  for (const key of [
    "pythonpath",
    "pythonstartup",
    "ld_sentinel",
    "dyld_sentinel",
    "openrouter_key",
    "typesafe_key",
  ]) {
    if (result[key] != null) {
      throw new Error("Sanitized producer environment leaked " + key);
    }
  }
  if (result.source_first !== join(repoRoot, "src")) {
    throw new Error("Exact-head source tree was not first on isolated sys.path");
  }

  process.stdout.write("System-One producer Python isolation self-test passed.\n");
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.SYSTEM_ONE_SITECUSTOMIZE_MARKER;
  rmSync(root, { recursive: true, force: true });
}
