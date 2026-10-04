import { expect, test } from "bun:test";
import { engineSpec } from "../../src/modules/compute/engines/registry";
import type {
  EngineId,
  HostProfile,
  LaunchRequest,
  ServingOptions,
} from "../../src/modules/compute/contracts";

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

const options = (overrides: Partial<ServingOptions> = {}): ServingOptions => ({
  tensorParallel: 1,
  pipelineParallel: 1,
  maxContextLength: 32768,
  memoryFraction: 0.9,
  maxConcurrentRequests: 64,
  kvCacheDtype: null,
  dtype: null,
  quantization: null,
  trustRemoteCode: true,
  toolCallParser: null,
  enableAutoToolChoice: false,
  reasoningParser: null,
  ...overrides,
});

const argv = (engine: EngineId, serving: ServingOptions): string[] => {
  const request: LaunchRequest = {
    engine,
    host: HOST,
    runtime: "docker",
    devices: [],
    port: 8000,
    modelPath: "/models/weights",
    servedModelName: "candidate",
    options: serving,
    extraArgs: [],
    env: {},
    dockerImage: null,
    binary: "",
  };
  return [...engineSpec(engine).plan(request).argv];
};

const has = (tokens: readonly string[], flag: string): boolean => tokens.includes(flag);

test("a tool call parser alone no longer implies auto tool choice", () => {
  const tokens = argv("vllm", options({ toolCallParser: "qwen3_xml" }));
  expect(has(tokens, "--tool-call-parser")).toBe(true);
  expect(has(tokens, "--enable-auto-tool-choice")).toBe(false);
});

test("a parser with auto tool choice emits both flags", () => {
  const tokens = argv(
    "vllm",
    options({ toolCallParser: "qwen3_xml", enableAutoToolChoice: true }),
  );
  expect(has(tokens, "--tool-call-parser")).toBe(true);
  expect(has(tokens, "--enable-auto-tool-choice")).toBe(true);
});

test("auto tool choice without a parser still emits its flag", () => {
  const tokens = argv("vllm", options({ enableAutoToolChoice: true }));
  expect(has(tokens, "--enable-auto-tool-choice")).toBe(true);
  expect(has(tokens, "--tool-call-parser")).toBe(false);
});

test("neither flag appears when neither is requested", () => {
  const tokens = argv("vllm", options());
  expect(has(tokens, "--tool-call-parser")).toBe(false);
  expect(has(tokens, "--enable-auto-tool-choice")).toBe(false);
});

test("SGLang has no auto tool choice flag, matching the command preview", () => {
  const tokens = argv(
    "sglang",
    options({ toolCallParser: "qwen3_xml", enableAutoToolChoice: true }),
  );
  expect(has(tokens, "--enable-auto-tool-choice")).toBe(false);
  expect(has(tokens, "--tool-call-parser")).toBe(true);
});

test("engines without the knob drop it rather than guessing", () => {
  for (const engine of ["llamacpp", "mlx"] as const) {
    const tokens = argv(engine, options({ enableAutoToolChoice: true }));
    expect(has(tokens, "--enable-auto-tool-choice")).toBe(false);
  }
});

test("auto tool choice appears before the reasoning parser in emission order", () => {
  const tokens = argv(
    "vllm",
    options({
      toolCallParser: "qwen3_xml",
      enableAutoToolChoice: true,
      reasoningParser: "deepseek_r1",
    }),
  );
  const toolIndex = tokens.indexOf("--tool-call-parser");
  const autoIndex = tokens.indexOf("--enable-auto-tool-choice");
  const reasoningIndex = tokens.indexOf("--reasoning-parser");
  expect(toolIndex).toBeGreaterThan(-1);
  expect(autoIndex).toBeGreaterThan(toolIndex);
  expect(reasoningIndex).toBeGreaterThan(autoIndex);
});