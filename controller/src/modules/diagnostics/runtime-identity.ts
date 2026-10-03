import { Schema } from "effect";
import type {
  DiagnosticProfile,
  ModelIdentity,
  RuntimeIdentity,
} from "@local-studio/contracts/inference-diagnostics";

export class DiagnosticProfileError extends Schema.TaggedErrorClass<DiagnosticProfileError>()(
  "DiagnosticProfileError",
  { profile: Schema.String, detail: Schema.String },
) {}

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export interface ModelCatalog {
  readonly reachable: boolean;
  readonly entries: readonly Rec[];
}

export const emptyCatalog = (): ModelCatalog => ({ reachable: false, entries: [] });

export const catalogFromPayload = (payload: unknown, reachable: boolean): ModelCatalog => {
  const data = isRec(payload) && Array.isArray(payload["data"]) ? payload["data"] : [];
  return { reachable, entries: data.filter(isRec) };
};

export const runtimeIdentityFrom = (
  baseUrl: string,
  catalog: ModelCatalog,
  engine: string | null = null,
): RuntimeIdentity => ({
  base_url: baseUrl,
  engine,
  engine_image: null,
  server_model_ids: catalog.entries
    .map((entry) => stringOrNull(entry["id"]))
    .filter((id): id is string => id !== null),
  reachable: catalog.reachable,
});

export const modelIdentityFrom = (
  catalog: ModelCatalog,
  requested: string,
): ModelIdentity => {
  const lower = requested.toLowerCase();
  const served = catalog.entries.find(
    (entry) => stringOrNull(entry["id"])?.toLowerCase() === lower,
  );
  return {
    requested,
    served_as: stringOrNull(served?.["id"]),
    max_model_len: numberOrNull(served?.["max_model_len"]),
    matched: served !== undefined,
  };
};

/**
 * Describes why a profile is unusable, or null when it is sound. Kept pure and
 * string-returning so the caller decides whether that becomes a typed failure
 * rather than throwing across an Effect boundary.
 */
export const profileBoundsProblem = (profile: DiagnosticProfile): string | null => {
  if (profile.max_output_tokens <= 0) {
    return `profile ${profile.name} has a non-positive max_output_tokens`;
  }
  if (profile.max_input_tokens <= 0) {
    return `profile ${profile.name} has a non-positive max_input_tokens`;
  }
  const budget = profile.reasoning_budget_tokens;
  if (budget !== null && (!Number.isInteger(budget) || budget < 0)) {
    return `profile ${profile.name} has reasoning_budget_tokens ${budget}, which is not a non-negative integer`;
  }
  if (budget !== null && budget > profile.max_output_tokens) {
    return `profile ${profile.name} budgets ${budget} reasoning tokens inside a ${profile.max_output_tokens} token output, leaving no room for a final answer`;
  }
  if (profile.first_token_timeout_ms >= profile.timeout_ms) {
    return `profile ${profile.name} waits ${profile.first_token_timeout_ms}ms for the first token inside a ${profile.timeout_ms}ms budget`;
  }
  return null;
};