/**
 * Bounded, read-only inference qualification probe.
 *
 * Sends exactly two requests to an already-running private runtime: one
 * GET /v1/models for identity, and one bounded chat completion for the
 * diagnostic. It never loads, stops, downloads, registers, or admits
 * anything, and it never routes through the controller proxy, so proxy
 * model gating and proxy content normalization cannot hide the failure.
 *
 *   bun --cwd controller probe-inference-runtime.ts \
 *     --base-url http://127.0.0.1:8081 \
 *     --model Ternary-Bonsai-2-27B-PQ2_0 \
 *     --profile short_reasoning \
 *     --engine llamacpp
 *
 * Exit status: 0 when the classification is OUTPUT_OK, 1 for any other
 * classification, 2 for a usage error.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Exit } from "effect";
import { runQualificationProbe } from "./src/modules/diagnostics/probe";
import {
  diagnosticProfile,
  isDiagnosticProfileName,
} from "./src/modules/diagnostics/diagnostic-profiles";
import { recipeEvidence } from "./src/modules/diagnostics/evidence";
import { assertProfileBounds } from "./src/modules/diagnostics/runtime-identity";
import { parseRecipe } from "./src/modules/models/recipes/recipe-serializer";
import type { DiagnosticReport, RecipeQualificationEvidence } from "./contracts/inference-diagnostics";
import type { Recipe } from "./src/modules/models/types";

const USAGE = [
  "Usage: bun --cwd controller probe-inference-runtime.ts --base-url <url> --model <id> --profile <name> [options]",
  "",
  "Required:",
  "  --base-url <url>      Root of an already-running OpenAI-compatible runtime",
  "  --model <id>          Model identifier to request",
  "  --profile <name>      protocol_canary | exact_grounding | short_reasoning | bounded_code",
  "",
  "Optional:",
  "  --engine <id>         vllm | sglang | llamacpp | mlx. Selects the bounded-output field and the reasoning support states",
  "  --engine-image <ref>  Runtime image or binary reference, recorded as identity evidence",
  "  --api-key-env <name>  Environment variable holding the runtime key (default INFERENCE_API_KEY)",
  "  --recipe <id>         Emit portable recipe evidence for this recipe id",
  "  --data-dir <path>     Directory holding model-index.json (default $LOCAL_STUDIO_DATA_DIR or ./data)",
  "  --compact             Print single-line JSON",
  "  --list-profiles       Print the profile catalog and exit",
  "  --help                Print this message",
].join("\n");

interface Options {
  baseUrl: string | null;
  model: string | null;
  profile: string | null;
  engine: string | null;
  engineImage: string | null;
  apiKeyEnv: string;
  recipe: string | null;
  dataDirectory: string;
  compact: boolean;
  listProfiles: boolean;
  help: boolean;
}

class UsageError extends Error {}

const takeValue = (args: readonly string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
};

const parseOptions = (args: readonly string[]): Options => {
  const options: Options = {
    baseUrl: null,
    model: null,
    profile: null,
    engine: null,
    engineImage: null,
    apiKeyEnv: "INFERENCE_API_KEY",
    recipe: null,
    dataDirectory: process.env["LOCAL_STUDIO_DATA_DIR"] ?? resolve(process.cwd(), "data"),
    compact: false,
    listProfiles: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    switch (flag) {
      case "--base-url": options.baseUrl = takeValue(args, index, flag); index += 1; break;
      case "--model": options.model = takeValue(args, index, flag); index += 1; break;
      case "--profile": options.profile = takeValue(args, index, flag); index += 1; break;
      case "--engine": options.engine = takeValue(args, index, flag); index += 1; break;
      case "--engine-image": options.engineImage = takeValue(args, index, flag); index += 1; break;
      case "--api-key-env": options.apiKeyEnv = takeValue(args, index, flag); index += 1; break;
      case "--recipe": options.recipe = takeValue(args, index, flag); index += 1; break;
      case "--data-dir": options.dataDirectory = takeValue(args, index, flag); index += 1; break;
      case "--compact": options.compact = true; break;
      case "--list-profiles": options.listProfiles = true; break;
      case "--help": case "-h": options.help = true; break;
      default: throw new UsageError(`unknown flag ${flag}`);
    }
  }
  return options;
};

const loadRecipe = (dataDirectory: string, recipeId: string): Recipe => {
  const path = resolve(dataDirectory, "model-index.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new UsageError(
      `cannot read the recipe registry at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries)
      : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { id?: unknown; name?: unknown; serve?: unknown };
    if (record.id !== recipeId) continue;
    const serve =
      typeof record.serve === "object" && record.serve !== null
        ? (record.serve as Record<string, unknown>)
        : {};
    return parseRecipe({
      id: recipeId,
      name: typeof record.name === "string" ? record.name : recipeId,
      ...serve,
    });
  }
  throw new UsageError(`recipe ${recipeId} is not in ${path}`);
};

const profileCatalog = (): unknown =>
  ["protocol_canary", "exact_grounding", "short_reasoning", "bounded_code"].map((name) => {
    const profile = diagnosticProfile(name);
    if (!profile) return { name };
    return {
      name: profile.name,
      purpose: profile.purpose,
      max_input_tokens: profile.max_input_tokens,
      max_output_tokens: profile.max_output_tokens,
      temperature: profile.temperature,
      reasoning_budget_tokens: profile.reasoning_budget_tokens,
      timeout_ms: profile.timeout_ms,
      first_token_timeout_ms: profile.first_token_timeout_ms,
      stream: profile.stream,
      stop: profile.stop,
      expected_answer: profile.expected_answer,
    };
  });

const main = async (args: readonly string[]): Promise<number> => {
  const options = parseOptions(args);
  if (options.help || options.listProfiles) {
    if (options.listProfiles) {
      console.log(JSON.stringify(profileCatalog(), null, 2));
      return 0;
    }
    console.log(USAGE);
    return 0;
  }
  if (!options.baseUrl || !options.model || !options.profile) {
    throw new UsageError("--base-url, --model and --profile are required");
  }
  if (!isDiagnosticProfileName(options.profile)) {
    throw new UsageError(
      `unknown profile ${options.profile}; expected one of protocol_canary, exact_grounding, short_reasoning, bounded_code`,
    );
  }
  const profile = diagnosticProfile(options.profile);
  if (!profile) throw new UsageError(`unknown profile ${options.profile}`);
  assertProfileBounds(profile);

  const outcome = await Effect.runPromiseExit(
    runQualificationProbe({
      base_url: options.baseUrl,
      model: options.model,
      profile,
      engine: options.engine,
      engine_image: options.engineImage,
      api_key: process.env[options.apiKeyEnv] ?? null,
      probed_at: new Date().toISOString(),
    }),
  );
  if (Exit.isFailure(outcome)) {
    throw new Error(`probe failed: ${String(outcome.cause)}`);
  }

  const report: DiagnosticReport = outcome.value;
  const payload: Record<string, unknown> = { report };
  if (options.recipe) {
    const recipe = loadRecipe(options.dataDirectory, options.recipe);
    const evidence: RecipeQualificationEvidence = recipeEvidence({ recipe, profile, report });
    payload["evidence"] = evidence;
  }
  console.log(JSON.stringify(payload, null, options.compact ? 0 : 2));
  return report.result.classification === "OUTPUT_OK" ? 0 : 1;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    console.error("");
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}