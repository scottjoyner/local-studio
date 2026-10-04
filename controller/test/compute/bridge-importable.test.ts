import { expect, test } from "bun:test";
import { recipeToLaunchInput } from "../../src/modules/compute/bridge";
import { planLaunch } from "../../src/modules/compute/engines/registry";
import { parseRecipe } from "../../src/modules/models/recipes/recipe-serializer";
import type { Config } from "../../src/config/env";
import type { HostProfile, LaunchRequest } from "../../src/modules/compute/contracts";

/**
 * `recipeToLaunchInput` used to be unimportable outside the request path: it value-imported
 * `resolveLlamaBinary` from `engines/specs/llamacpp-spec`, which transitively re-entered
 * `engines/engine-spec` while `llamacppSpec` was still in its temporal dead zone. Importing this
 * module at all threw `ReferenceError: Cannot access 'llamacppSpec' before initialization`, so the
 * whole recipe-to-argv path could only be tested by reimplementing it.
 *
 * `resolveLlamaBinary` now lives in `compute/llamacpp-binary`, which depends only on
 * `argument-utilities`, `core/command`, and `managed-llamacpp` — all cycle-free. These tests are
 * the regression guard: if that edge is ever reconnected, this file fails to load.
 */

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

const argvFor = (over: Record<string, unknown> = {}): readonly string[] => {
  const recipe = parseRecipe(draft(over) as never);
  const input = recipeToLaunchInput(recipe, CONFIG, ["cuda:GPU-0000"]);
  const request = { ...input, host: HOST, port: 8000 } as unknown as LaunchRequest;
  return planLaunch(request).argv;
};

test("recipe-to-argv is reachable without the engine-spec cycle", () => {
  const argv = argvFor();
  expect(argv.length).toBeGreaterThan(0);
  expect(argv[0]).toContain("llama-server");
});

test("llama.cpp carries the reasoning-format default that the recipe preview omits", () => {
  // The frontend preview never renders `--reasoning-format`, so a user configuring a reasoning
  // model sees a command with no reasoning configuration at all. On MiniCPM5 this flag is what
  // decides whether reasoning is separated into `reasoning_content` or left inline, and the
  // template's own `--reasoning-preserve` default differs per model (on for Ornith, opt-in for
  // MiniCPM5). The preview being wrong here is a correctness bug, not cosmetics.
  expect(argvFor({ extra_args: { reasoning_model: "deepseek" } })).toContain("--reasoning-format");
  expect(argvFor()).toContain("--metrics");
});

test("llama.cpp still maps max_num_seqs onto --parallel", () => {
  expect(argvFor()).toContain("--parallel");
});
