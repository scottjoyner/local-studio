import type {
  DiagnosticProfile,
  DiagnosticReport,
  RecipeIncompatibility,
  RecipeQualificationEvidence,
  ReasoningBudgetResolution,
} from "@local-studio/contracts/inference-diagnostics";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Backend } from "@local-studio/contracts/recipes";
import type { Recipe } from "../models/types";
import { parseRecipe } from "../models/recipes/recipe-serializer";
import { resolveReasoningBudget } from "./reasoning-support";

const REGISTRY_FILENAME = "model-index.json";

export class RecipeRegistryError extends Error {}

const entriesOf = (parsed: unknown): unknown[] => {
  if (typeof parsed !== "object" || parsed === null) return [];
  const entries = (parsed as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries : [];
};

/**
 * Reads one recipe out of the registry the controller already writes. The
 * registry file is the recipe source of truth, so this reads it rather than
 * keeping a second copy, and it never writes.
 */
export const readRecipeFromRegistry = (
  dataDirectory: string,
  recipeId: string,
): Recipe => {
  const path = resolve(dataDirectory, REGISTRY_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    throw new RecipeRegistryError(
      `cannot read the recipe registry at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const entry of entriesOf(parsed)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { id?: unknown; name?: unknown; serve?: unknown };
    if (record.id !== recipeId) continue;
    const serve =
      typeof record.serve === "object" && record.serve !== null
        ? (record.serve as Record<string, unknown>)
        : {};
    try {
      return parseRecipe({
        id: recipeId,
        name: typeof record.name === "string" ? record.name : recipeId,
        ...serve,
      });
    } catch (error) {
      throw new RecipeRegistryError(
        `recipe ${recipeId} in ${path} is not valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new RecipeRegistryError(`recipe ${recipeId} is not in ${path}`);
};

const LLAMACPP_UNSPELLED = [
  "tensor_parallel_size",
  "pipeline_parallel_size",
  "gpu_memory_utilization",
  "kv_cache_dtype",
  "max_num_seqs",
  "trust_remote_code",
  "dtype",
  "quantization",
] as const;

const incompatibleKnobs = (backend: Backend): RecipeIncompatibility[] =>
  LLAMACPP_UNSPELLED.map((id) => ({
    id: `dropped.${id}`,
    detail: `${backend} has no command-line equivalent for ${id}, so this recipe value is persisted but never reaches the runtime.`,
    blocks: null,
  }));

const ENGINE_INCOMPATIBILITIES: Readonly<Record<Backend, readonly RecipeIncompatibility[]>> = {
  vllm: [
    {
      id: "reasoning.no_budget_flag",
      detail:
        "vLLM exposes no reasoning token budget flag. reasoning_parser only decides where reasoning is reported, so a bounded run can still return no final content.",
      blocks: "short_reasoning",
    },
  ],
  sglang: [
    {
      id: "reasoning.no_budget_flag",
      detail:
        "SGLang exposes no reasoning token budget flag. reasoning_parser only decides where reasoning is reported, so a bounded run can still return no final content.",
      blocks: "short_reasoning",
    },
  ],
  llamacpp: [
    {
      id: "reasoning.budget_is_launch_time_only",
      detail:
        "--reasoning-budget is fixed when llama-server starts, so a running runtime cannot be re-budgeted from a request and a probe cannot verify the effective value.",
      blocks: "short_reasoning",
    },
    ...incompatibleKnobs("llamacpp"),
  ],
  mlx: [
    {
      id: "context.max_tokens_spelling",
      detail:
        "max_model_len is spelled --max-tokens for mlx_lm.server, which bounds output rather than the context window, so a context claim from this recipe is not the runtime's.",
      blocks: null,
    },
    {
      id: "reasoning.no_parser_flag",
      detail:
        "mlx_lm.server is launched with no reasoning flags, so reasoning arrives inside content on every request.",
      blocks: "short_reasoning",
    },
  ],
};

export interface RecipeEvidenceInput {
  readonly recipe: Recipe;
  readonly profile: DiagnosticProfile;
  readonly report: DiagnosticReport;
}

const boundedFrom = (profile: DiagnosticProfile): RecipeQualificationEvidence["bounded_output"] => ({
  max_input_tokens: profile.max_input_tokens,
  max_output_tokens: profile.max_output_tokens,
  temperature: profile.temperature,
  timeout_ms: profile.timeout_ms,
  stream: profile.stream,
});

export const recipeEvidence = ({
  recipe,
  profile,
  report,
}: RecipeEvidenceInput): RecipeQualificationEvidence => {
  const budget: ReasoningBudgetResolution = resolveReasoningBudget({
    engine: recipe.backend,
    requested: recipe.max_thinking_tokens,
    maxOutputTokens: null,
  });
  const engine = ENGINE_INCOMPATIBILITIES[recipe.backend] ?? [];

  return {
    schema_version: "1",
    model: {
      model_path: recipe.model_path,
      served_model_name: recipe.served_model_name,
      quantization: recipe.quantization,
      dtype: recipe.dtype,
      context_tokens: recipe.max_model_len,
    },
    engine: {
      backend: recipe.backend,
      runtime_kind: recipe.runtime.kind,
      runtime_ref: recipe.runtime.ref,
    },
    bounded_output: boundedFrom(profile),
    reasoning: budget,
    known_incompatibilities: [...engine],
    diagnostics: [
      {
        profile: profile.name,
        classification: report.result.classification,
        probed_at: report.probed_at,
      },
    ],
  };
};