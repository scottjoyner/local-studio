import { expect, test } from "bun:test";
import { previewRecipeLaunch } from "../../src/modules/compute/recipe-preview";
import { planLaunch, engineSpec } from "../../src/modules/compute/engines/registry";
import { recipeToLaunchInput } from "../../src/modules/compute/bridge";
import { parseRecipe } from "../../src/modules/models/recipes/recipe-serializer";
import type { Config } from "../../src/config/env";
import type { GpuInfo } from "../../src/modules/models/types";
import type { HostProfile, LaunchRequest } from "../../src/modules/compute/contracts";
import type { RecipeLaunchPreview } from "../../contracts/recipes";

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

const recipeOf = (over: Record<string, unknown> = {}): ReturnType<typeof parseRecipe> => parseRecipe(draft(over) as never);

const previewFor = (over: Record<string, unknown> = {}): RecipeLaunchPreview =>
  previewRecipeLaunch(recipeOf(over), CONFIG, HOST, GPUS);

test("preview reproduces the launch plan for the same inputs", () => {
  // Guards the field mapping in previewRecipeLaunch against lifecycle.ts: a dropped
  // extraArgs, option, or binary default would silently desync the preview from the launch.
  const recipe = recipeOf();
  const spec = engineSpec(recipe.backend);
  const input = recipeToLaunchInput(recipe, CONFIG, ["cuda:GPU-0000"]);
  const launch = planLaunch({
    engine: input.engine,
    host: HOST,
    runtime: input.runtime,
    devices: ["cuda:GPU-0000"],
    port: 8000,
    modelPath: input.modelPath,
    servedModelName: input.servedModelName,
    options: input.options,
    extraArgs: input.extraArgs,
    env: input.env,
    dockerImage: input.dockerImage,
    binary: input.binary ?? spec.defaultBinary,
  } as unknown as LaunchRequest);

  expect([...previewFor().argv]).toEqual([...launch.argv]);
});

test("preview carries the llama.cpp reasoning flags the editor preview omitted", () => {
  // These are the flags that made the divergence a correctness bug rather than cosmetics: a
  // user configuring a reasoning model was shown no reasoning configuration at all while
  // launch applied `--reasoning-format deepseek`.
  const argv = previewFor({ extra_args: { reasoning_model: "deepseek" } }).argv;
  expect(argv).toContain("--reasoning-format");
  expect(argv).toContain("--metrics");
  expect(argv).toContain("--parallel");
});

test("preview includes every flag the editor preview omitted", () => {
  // Measured divergence, controller-side only. Comparing against the frontend builder directly
  // is not possible yet: `recipe-command` and the compute graph cannot both be imported in one
  // process, because the legacy `engine-spec` <-> `runtime-info` <-> specs cycle is still live
  // (sglangSpec and mlxSpec hold real runtime-info logic *and* import runtime-info helpers).
  // That cycle is pre-existing and out of scope here. These assertions pin the flags that the
  // editor previously withheld, which is the substance of the bug.
  const llamacpp = previewFor({ extra_args: { reasoning_model: "deepseek" } }).argv;
  for (const flag of ["--reasoning-format", "--metrics", "--parallel"]) {
    expect(llamacpp).toContain(flag);
  }
});

test("mlx preview carries --max-tokens and --trust-remote-code", () => {
  const argv = previewFor({ backend: "mlx", python_path: "/venv/bin/python" }).argv;
  expect(argv).toContain("--max-tokens");
  expect(argv).toContain("--trust-remote-code");
});

test("a custom launch command is ignored unless the operator opted in", () => {
  // Arbitrary-binary execution as the controller user is gated behind an explicit env var.
  // The preview must not bypass that gate, or it would advertise a command the launcher
  // refuses to run.
  const withoutOptIn = previewFor({ extra_args: { launch_command: "my-server --flag value" } });
  expect(withoutOptIn.argv).not.toEqual(["my-server", "--flag", "value"]);

  const previous = process.env["LOCAL_STUDIO_ALLOW_CUSTOM_LAUNCH_COMMAND"];
  process.env["LOCAL_STUDIO_ALLOW_CUSTOM_LAUNCH_COMMAND"] = "true";
  try {
    const optedIn = previewFor({ extra_args: { launch_command: "my-server --flag value" } });
    expect(optedIn.argv).toEqual(["my-server", "--flag", "value"]);
  } finally {
    if (previous === undefined) delete process.env["LOCAL_STUDIO_ALLOW_CUSTOM_LAUNCH_COMMAND"];
    else process.env["LOCAL_STUDIO_ALLOW_CUSTOM_LAUNCH_COMMAND"] = previous;
  }
});

test("unresolvable GPU selectors surface as a warning rather than throwing", () => {
  // A selector naming a GPU that does not exist resolves to nothing. Without an explicit
  // selector `unresolvedTokens` is always empty, so the recipe has to name a device.
  const preview = previewRecipeLaunch(
    recipeOf({ extra_args: { visible_devices: "9" } }),
    CONFIG,
    HOST,
    [] as unknown as readonly GpuInfo[],
  );
  expect(preview.warnings.join(" ")).toContain("GPU selectors could not be resolved");
});

test("docker preview warns that container paths are resolved at mount time", () => {
  const preview = previewFor({ runtime: { kind: "docker", ref: "img:tag" } });
  expect(preview.kind).toBe("docker");
  expect(preview.warnings.join(" ")).toContain("mount time");
});
