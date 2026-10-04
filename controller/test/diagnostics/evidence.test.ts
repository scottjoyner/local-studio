import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runQualificationProbe } from "../../src/modules/diagnostics/probe";
import { diagnosticProfile } from "../../src/modules/diagnostics/diagnostic-profiles";
import { reasoningSeparationFor } from "../../src/modules/diagnostics/reasoning-support";
import {
  RecipeRegistryError,
  readRecipeFromRegistry,
  recipeEvidence,
} from "../../src/modules/diagnostics/evidence";
import type { DiagnosticReport } from "@local-studio/contracts/inference-diagnostics";

const MODEL_ID = "Ternary-Bonsai-2-27B-PQ2_0";
const PROBED_AT = "2026-10-02T00:00:00.000Z";

let registryDirectory: string;

const writeRegistry = (contents: unknown): void => {
  writeFileSync(
    join(registryDirectory, "model-index.json"),
    `${JSON.stringify(contents, null, 2)}\n`,
    "utf-8",
  );
};

const registryWith = (serve: Record<string, unknown>, id = "bonsai2-llamacpp"): unknown => ({
  version: 1,
  tiers: [],
  entries: [{ id, name: "Bonsai 2", serve }],
});

const LLAMACPP_SERVE: Record<string, unknown> = {
  model_path: "/models/Ternary-Bonsai-2-27B-PQ2_0.gguf",
  backend: "llamacpp",
  runtime: { kind: "docker", ref: "ghcr.io/ggml-org/llama.cpp:server-rocm" },
  served_model_name: MODEL_ID,
  max_model_len: 32_768,
  quantization: "PQ2_0",
  max_thinking_tokens: 256,
};

const probeOnce = async (): Promise<DiagnosticReport> => {
  const server = Bun.serve({
    port: 0,
    fetch: (request: Request) => {
      if (new URL(request.url).pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: MODEL_ID, max_model_len: 32_768 }] });
      }
      const frame = (payload: Record<string, unknown>): Uint8Array =>
        new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller: ReadableStreamDefaultController<Uint8Array>): void {
            controller.enqueue(
              frame({ choices: [{ index: 0, delta: { content: "0.05" }, finish_reason: "stop" }] }),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  try {
    return await Effect.runPromise(
      runQualificationProbe({
        base_url: `http://127.0.0.1:${server.port}`,
        model: MODEL_ID,
        profile,
        engine: "llamacpp",
        engine_image: null,
        api_key: null,
        probed_at: PROBED_AT,
      }),
    );
  } finally {
    server.stop(true);
  }
};

beforeAll(() => {
  registryDirectory = mkdtempSync(join(tmpdir(), "local-studio-qualification-"));
});

afterAll(() => {
  rmSync(registryDirectory, { recursive: true, force: true });
});

test("a recipe is read from the registry the controller already writes", () => {
  writeRegistry(registryWith(LLAMACPP_SERVE));
  const recipe = readRecipeFromRegistry(registryDirectory, "bonsai2-llamacpp");
  expect(String(recipe.id)).toBe("bonsai2-llamacpp");
  expect(recipe.backend).toBe("llamacpp");
  expect(recipe.model_path).toBe("/models/Ternary-Bonsai-2-27B-PQ2_0.gguf");
  expect(recipe.max_thinking_tokens).toBe(256);
});

test("a missing registry file is reported rather than silently ignored", () => {
  expect(() => readRecipeFromRegistry(join(registryDirectory, "absent"), "bonsai2")).toThrow(
    RecipeRegistryError,
  );
});

test("an unknown recipe id is reported", () => {
  writeRegistry(registryWith(LLAMACPP_SERVE));
  expect(() => readRecipeFromRegistry(registryDirectory, "not-a-recipe")).toThrow(
    RecipeRegistryError,
  );
});

test("a registry with no entries array reads as empty instead of crashing", () => {
  writeRegistry({ version: 1 });
  expect(() => readRecipeFromRegistry(registryDirectory, "bonsai2-llamacpp")).toThrow(
    RecipeRegistryError,
  );
});

test("evidence records the engine's real limits and carries no hardware placement", async () => {
  writeRegistry(registryWith(LLAMACPP_SERVE));
  const recipe = readRecipeFromRegistry(registryDirectory, "bonsai2-llamacpp");
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  const evidence = recipeEvidence({ recipe, profile, report: await probeOnce() });

  expect(evidence.schema_version).toBe("1");
  expect(evidence.model.quantization).toBe("PQ2_0");
  expect(evidence.model.context_tokens).toBe(32_768);
  expect(evidence.engine.backend).toBe("llamacpp");
  expect(evidence.bounded_output.max_output_tokens).toBe(256);
  expect(evidence.reasoning.state).toBe("SUPPORTED");
  expect(evidence.reasoning.engine_flag).toBe("--reasoning-budget");
  expect(evidence.diagnostics).toEqual([
    { profile: "short_reasoning", classification: "OUTPUT_OK", probed_at: PROBED_AT },
  ]);

  const ids = evidence.known_incompatibilities.map((entry) => entry.id);
  expect(ids).toContain("reasoning.budget_is_launch_time_only");
  expect(ids).toContain("dropped.quantization");
  expect(ids).toContain("dropped.tensor_parallel_size");
  expect(evidence.known_incompatibilities.some((entry) => entry.blocks === "short_reasoning")).toBe(
    true,
  );

  const shape = Object.keys(evidence).sort();
  expect(shape).toEqual([
    "bounded_output",
    "diagnostics",
    "engine",
    "known_incompatibilities",
    "model",
    "reasoning",
    "schema_version",
  ]);
  expect(Object.keys(evidence.model).sort()).toEqual([
    "context_tokens",
    "dtype",
    "model_path",
    "quantization",
    "served_model_name",
  ]);
  expect(Object.keys(evidence.engine).sort()).toEqual([
    "backend",
    "runtime_kind",
    "runtime_ref",
  ]);
  const serialized = JSON.stringify(evidence).toLowerCase();
  for (const node of ["optiplex", "lenovo", "destroyer", "hostname", "host_id", "node_id"]) {
    expect(serialized).not.toContain(node);
  }
});

test("evidence for a vLLM recipe records its per-request budget field", async () => {
  writeRegistry(
    registryWith(
      {
        model_path: "/models/kimi-k2",
        backend: "vllm",
        runtime: { kind: "docker", ref: "rocm/vllm:latest" },
        served_model_name: "kimi-k2",
        max_model_len: 131_072,
        max_thinking_tokens: 1_024,
        reasoning_parser: "deepseek_r1",
      },
      "k2-vllm",
    ),
  );
  const recipe = readRecipeFromRegistry(registryDirectory, "k2-vllm");
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  const evidence = recipeEvidence({ recipe, profile, report: await probeOnce() });

  expect(evidence.reasoning.state).toBe("SUPPORTED");
  expect(evidence.reasoning.request_field).toBe("thinking_token_budget");
  expect(evidence.reasoning.applies_to_request).toBe(true);
  expect(evidence.reasoning.engine_flag).toBeNull();
  expect(evidence.reasoning.requested).toBe(1_024);
});

test("a recipe budget is not measured against the probe profile's output cap", async () => {
  writeRegistry(
    registryWith({ ...LLAMACPP_SERVE, max_thinking_tokens: 100_000 }, "oversized-llamacpp"),
  );
  const recipe = readRecipeFromRegistry(registryDirectory, "oversized-llamacpp");
  const profile = diagnosticProfile("protocol_canary");
  if (!profile) throw new Error("protocol_canary profile is missing");
  const evidence = recipeEvidence({ recipe, profile, report: await probeOnce() });

  expect(evidence.reasoning.requested).toBe(100_000);
  expect(evidence.reasoning.state).toBe("SUPPORTED");
  expect(evidence.reasoning.compared_against_output_cap).toBeNull();
});

test("a negative recipe budget is invalid regardless of any output cap", async () => {
  writeRegistry(
    registryWith({ ...LLAMACPP_SERVE, max_thinking_tokens: -5 }, "negative-llamacpp"),
  );
  const recipe = readRecipeFromRegistry(registryDirectory, "negative-llamacpp");
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  const evidence = recipeEvidence({ recipe, profile, report: await probeOnce() });

  expect(evidence.reasoning.state).toBe("INVALID_CONFIGURATION");
  expect(evidence.reasoning.detail).toContain("negative");
});

test("a recipe that declares no budget reports null rather than borrowing the profile's", async () => {
  const withoutBudget: Record<string, unknown> = { ...LLAMACPP_SERVE };
  delete withoutBudget["max_thinking_tokens"];
  writeRegistry(registryWith(withoutBudget, "silent-llamacpp"));
  const recipe = readRecipeFromRegistry(registryDirectory, "silent-llamacpp");
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  expect(profile.reasoning_budget_tokens).toBe(256);

  const evidence = recipeEvidence({ recipe, profile, report: await probeOnce() });
  expect(evidence.reasoning.requested).toBeNull();
  expect(evidence.reasoning.state).toBe("SUPPORTED");
});

test("llama.cpp evidence records the reasoning-preservation token cost", async () => {
  writeRegistry(registryWith(LLAMACPP_SERVE, "preserve-llamacpp"));
  const recipe = readRecipeFromRegistry(registryDirectory, "preserve-llamacpp");
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  const evidence = recipeEvidence({ recipe, profile, report: await probeOnce() });
  const ids = evidence.known_incompatibilities.map((entry) => entry.id);
  expect(ids).toContain("reasoning.preserve_costs_output_tokens");
  const entry = evidence.known_incompatibilities.find(
    (item) => item.id === "reasoning.preserve_costs_output_tokens",
  );
  expect(entry?.detail).toContain("--no-reasoning-preserve");
  expect(entry?.blocks).toBe("short_reasoning");
});

test("llama.cpp's separation detail names the reasoning-preservation lever", () => {
  const separation = reasoningSeparationFor("llamacpp");
  expect(separation.engine_flag).toBe("--reasoning-format");
  expect(separation.detail).toContain("--no-reasoning-preserve");
});
