import { expect, test } from "bun:test";
import { previewRecipeLaunch } from "../../src/modules/compute/recipe-preview";
import { parseRecipe } from "../../src/modules/models/recipes/recipe-serializer";
import type { Config } from "../../src/config/env";
import type { GpuInfo } from "../../src/modules/models/types";
import type { HostProfile } from "../../src/modules/compute/contracts";

/**
 * This file is the regression guard for the legacy engine-spec import cycle, and it only exists
 * because that cycle is gone.
 *
 * `engines/engine-spec` imported the specs, `llamacpp-spec` imported `getLlamacppRuntimeInfo`
 * from `runtimes/runtime-info`, and `runtime-info` imported `getEngineSpec` from the registry.
 * Whichever of those a module graph happened to evaluate first, the other two re-entered a module
 * still in its temporal dead zone and threw:
 *
 *   ReferenceError: Cannot access 'llamacppSpec' before initialization
 *
 * Each module imported cleanly on its own; only the combination failed. That made it impossible
 * to load the recipe planner and the frontend command builder into one process, so the preview
 * could not be compared against the thing it replaced. The aggregate runtime snapshot now lives
 * in `runtimes/system-runtime-info`, above the registry, and the cycle does not close.
 *
 * If the edge is ever reconnected, this file fails to load and every test below errors.
 */

// Loaded through a variable specifier so the controller's tsc does not follow it into the
// frontend graph, which uses the `@/` alias the controller tsconfig does not resolve. Same approach
// as preview-parity.test.ts. Bun still resolves it at runtime, so a reintroduced cycle still fails
// here - which is the whole point of this file.
const PREVIEW_MODULE = "../../../frontend/src/features/recipes/recipe-command";

type RecipeLike = Record<string, unknown>;

let cachedGenerate: ((recipe: RecipeLike, options?: { includeCommandOverride?: boolean }) => string) | null =
  null;

const generateCommand = async (recipe: RecipeLike): Promise<string> => {
  cachedGenerate ??= ((await import(PREVIEW_MODULE)) as {
    generateCommand: (value: RecipeLike, options?: { includeCommandOverride?: boolean }) => string;
  }).generateCommand;
  return cachedGenerate(recipe, { includeCommandOverride: false });
};

const CONFIG = { inference_port: 8000, llama_bin: "" } as unknown as Config;

const HOST = {
  nodeId: "self",
  platform: "linux",
  arch: "x64",
  accelerator: "cuda",
  unifiedMemory: false,
  wsl: false,
  docker: true,
  dockerGpu: true,
  deviceCount: 1,
} as unknown as HostProfile;

const GPUS = [
  { uuid: "GPU-0000", name: "test", memoryTotal: 32_000_000_000, vendor: "nvidia" },
] as unknown as readonly GpuInfo[];

const draft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "r1",
  name: "R",
  model_path: "/models/m",
  backend: "llamacpp",
  vision: null,
  env_vars: null,
  tensor_parallel_size: 1,
  pipeline_parallel_size: 1,
  max_model_len: 32768,
  gpu_memory_utilization: 0.9,
  kv_cache_dtype: "auto",
  max_num_seqs: 256,
  trust_remote_code: true,
  tool_call_parser: null,
  reasoning_parser: null,
  enable_auto_tool_choice: false,
  quantization: null,
  dtype: null,
  host: "0.0.0.0",
  port: 8000,
  served_model_name: "m",
  python_path: null,
  extra_args: null,
  max_thinking_tokens: null,
  runtime: { kind: "binary", ref: "llama-server" },
  ...over,
});

const parse = (over: Record<string, unknown> = {}): ReturnType<typeof parseRecipe> =>
  parseRecipe(draft(over) as never);

test("the planner and the frontend command builder import into one process", async () => {
  expect(typeof previewRecipeLaunch).toBe("function");
  expect(typeof (await generateCommand({}))).toBe("string");
});

test("the controller preview is a superset of what the local builder renders", async () => {
  // The comparison that could not be written before this cycle was fixed. The local builder is
  // still the frontend's fallback when the controller is unreachable, so it is worth pinning
  // exactly what it is missing: everything it does render must still be present, and the flags it
  // omits must be absent from it.
  const recipe = parse({ extra_args: { reasoning_model: "deepseek" } });
  const rendered = (await generateCommand(recipe as never))
    .split(/\s+/)
    .filter((token) => token !== "" && token !== "\\");
  const preview = previewRecipeLaunch(recipe, CONFIG, HOST, GPUS).argv;

  const flagsIn = (tokens: readonly string[]): Set<string> =>
    new Set(tokens.filter((t) => t.startsWith("--")).map((t) => t.split("=")[0] ?? t));

  const local = flagsIn(rendered);
  const authoritative = flagsIn(preview);

  for (const flag of local) {
    expect(authoritative.has(flag)).toBe(true);
  }
  expect(local.has("--reasoning-format")).toBe(false);
  expect(authoritative.has("--reasoning-format")).toBe(true);
});

test("mlx: the local builder omits flags the controller renders", async () => {
  const recipe = parse({ backend: "mlx", python_path: "/venv/bin/python" });
  const rendered = await generateCommand(recipe as never);
  const preview = previewRecipeLaunch(recipe, CONFIG, HOST, GPUS).argv;

  expect(rendered).not.toContain("--max-tokens");
  expect(preview).toContain("--max-tokens");
  expect(rendered).not.toContain("--trust-remote-code");
  expect(preview).toContain("--trust-remote-code");
});