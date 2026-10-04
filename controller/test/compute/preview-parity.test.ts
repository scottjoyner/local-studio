import { expect, test } from "bun:test";
import { engineSpec } from "../../src/modules/compute/engines/registry";
import type {
  EngineId,
  HostProfile,
  LaunchRequest,
  ServingOptions,
} from "../../src/modules/compute/contracts";

/**
 * The recipe editor previews a launch command by re-declaring, in the frontend,
 * what each engine's flags are. That duplication is why the preview and the real
 * launch have disagreed three times. This file pins the direction that actually
 * breaks things.
 *
 * The preview is allowed to omit flags the launcher emits — it is a summary, and
 * engine defaults come from tables the frontend cannot see. It is NOT allowed to
 * emit a flag, or a flag with a different value, that the launcher would not.
 * That direction produces a command a user can copy, run, and get something
 * different from what Local Studio would have done: a container bound to
 * 127.0.0.1, or a tool parser silently enabling auto tool choice.
 *
 * The omissions are recorded in docs/inference-qualification.md §9a. Fixing them
 * means rendering the preview from the controller's own plan rather than from a
 * second model of each engine, which is a design change and not attempted here.
 */

const HOST: HostProfile = {
  nodeId: "self",
  platform: "linux",
  arch: "x64",
  accelerator: "cuda",
  unifiedMemory: false,
  wsl: false,
  docker: true,
  dockerGpu: true,
  deviceCount: 1,
};

const ENGINES: readonly EngineId[] = ["vllm", "sglang", "llamacpp", "mlx"];

type RecipeLike = Record<string, unknown>;

const PREVIEW_MODULE = "../../../frontend/src/features/recipes/recipe-command";

let cachedGenerate: ((recipe: RecipeLike) => string) | null = null;

const generateCommand = async (recipe: RecipeLike): Promise<string> => {
  cachedGenerate ??= ((await import(PREVIEW_MODULE)) as {
    generateCommand: (value: RecipeLike) => string;
  }).generateCommand;
  return cachedGenerate(recipe);
};

const baseRecipe = (backend: EngineId): RecipeLike =>
  ({
    id: "r",
    name: "R",
    model_path: "/models/m",
    backend,
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
    runtime: { kind: "docker", ref: "image:tag" },
  }) as unknown as RecipeLike;

const launchArgv = (
  engine: EngineId,
  options: Partial<ServingOptions> = {},
): string[] => {
  const request: LaunchRequest = {
    engine,
    host: HOST,
    runtime: "docker",
    devices: [],
    port: 8000,
    modelPath: "/models/m",
    servedModelName: "m",
    options: {
      tensorParallel: 1,
      pipelineParallel: 1,
      maxContextLength: 32768,
      memoryFraction: 0.9,
      maxConcurrentRequests: 256,
      kvCacheDtype: null,
      dtype: null,
      quantization: null,
      trustRemoteCode: true,
      toolCallParser: null,
      enableAutoToolChoice: false,
      reasoningParser: null,
      ...options,
    },
    extraArgs: [],
    env: {},
    dockerImage: null,
    binary: "",
  };
  return [...engineSpec(engine).plan(request).argv];
};

/** Flatten an argv into comparable `--flag` and `--flag=value` entries. */
const signature = (tokens: readonly string[]): Set<string> => {
  const entries = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) continue;
    if (token.includes("=")) {
      entries.add(token);
      continue;
    }
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      entries.add(`${token}=${next}`);
      index += 1;
    } else {
      entries.add(token);
    }
  }
  return entries;
};

const MODEL_REFERENCE_FLAGS = new Set(["--model", "--model-path", "--model-dir"]);

const previewSignature = async (recipe: RecipeLike): Promise<Set<string>> => {
  const command = await generateCommand(recipe);
  const entries = signature(
    command.split(/\s+/).filter((token) => token !== "\\" && token.length > 0),
  );
  for (const entry of [...entries]) {
    const flag = entry.split("=")[0] ?? "";
    if (MODEL_REFERENCE_FLAGS.has(flag)) entries.delete(entry);
  }
  return entries;
};

test("the preview never emits a flag the launcher would not", async () => {
  for (const engine of ENGINES) {
    const launch = signature(launchArgv(engine));
    const preview = await previewSignature(baseRecipe(engine));
    const extra = [...preview].filter((entry) => !launch.has(entry));
    expect({ engine, extra }).toEqual({ engine, extra: [] });
  }
});

test("the preview never emits a flag with a value the launcher would not", async () => {
  const launch = signature(launchArgv("llamacpp"));
  const preview = await previewSignature({
    ...baseRecipe("llamacpp"),
    host: "127.0.0.1",
  });
  expect([...preview].filter((entry) => !launch.has(entry))).toEqual([]);
});

test("the preview resolves the bind address the launcher does", async () => {
  expect((await previewSignature(baseRecipe("llamacpp"))).has("--host=0.0.0.0")).toBe(true);
  const processRecipe = { ...baseRecipe("llamacpp"), runtime: { kind: "docker", ref: "" } };
  expect((await previewSignature(processRecipe)).has("--host=127.0.0.1")).toBe(true);
});

test("the preview does not imply auto tool choice from a parser", async () => {
  const recipe = {
    ...baseRecipe("vllm"),
    tool_call_parser: "qwen3_xml",
    enable_auto_tool_choice: false,
  };
  expect((await previewSignature(recipe)).has("--enable-auto-tool-choice")).toBe(false);
  const launch = signature(
    launchArgv("vllm", { toolCallParser: "qwen3_xml", enableAutoToolChoice: false }),
  );
  expect(launch.has("--enable-auto-tool-choice")).toBe(false);
});

test("the preview emits auto tool choice exactly when the recipe asks for it", async () => {
  const asked = {
    ...baseRecipe("vllm"),
    tool_call_parser: "qwen3_xml",
    enable_auto_tool_choice: true,
  };
  expect((await previewSignature(asked)).has("--enable-auto-tool-choice")).toBe(true);

  const sglangAsked = {
    ...baseRecipe("sglang"),
    tool_call_parser: "qwen3_xml",
    enable_auto_tool_choice: true,
  };
  expect((await previewSignature(sglangAsked)).has("--enable-auto-tool-choice")).toBe(false);
});