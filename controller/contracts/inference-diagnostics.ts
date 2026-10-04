import type { Backend } from "./recipes";

export const DIAGNOSTIC_PROFILE_NAMES = [
  "protocol_canary",
  "exact_grounding",
  "short_reasoning",
  "bounded_code",
] as const;

export type DiagnosticProfileName = (typeof DIAGNOSTIC_PROFILE_NAMES)[number];

export interface DiagnosticProfile {
  readonly name: DiagnosticProfileName;
  readonly purpose: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly temperature: number;
  readonly top_p: number;
  readonly reasoning_budget_tokens: number | null;
  readonly timeout_ms: number;
  readonly first_token_timeout_ms: number;
  readonly stream: boolean;
  readonly stop: readonly string[];
  readonly expect_grounded_answer: boolean;
  readonly prompt: string;
  readonly expected_answer: string | null;
}

export const REASONING_BUDGET_STATES = [
  "SUPPORTED",
  "UNSUPPORTED",
  "IGNORED_BY_ENGINE",
  "INVALID_CONFIGURATION",
  "UNOBSERVED",
] as const;

export type ReasoningBudgetState = (typeof REASONING_BUDGET_STATES)[number];

export const REASONING_BUDGET_MECHANISMS = ["request_field", "server_flag", "none"] as const;

export type ReasoningBudgetMechanism = (typeof REASONING_BUDGET_MECHANISMS)[number];

export interface ReasoningBudgetResolution {
  readonly field: "max_thinking_tokens";
  readonly requested: number | null;
  readonly state: ReasoningBudgetState;
  /** Output cap the budget was checked against, or null when none is in play. */
  readonly compared_against_output_cap: number | null;
  readonly mechanism: ReasoningBudgetMechanism;
  readonly engine_flag: string | null;
  readonly request_field: string | null;
  readonly applies_to_request: boolean;
  readonly detail: string;
}

export interface ReasoningSeparationResolution {
  readonly state: ReasoningBudgetState;
  readonly mechanism: ReasoningBudgetMechanism;
  readonly engine_flag: string | null;
  readonly request_field: string | null;
  readonly detail: string;
}

export const DIAGNOSTIC_CLASSIFICATIONS = [
  "OUTPUT_OK",
  "EMPTY_FINAL_CONTENT",
  "REASONING_ONLY",
  "LENGTH_TRUNCATED",
  "FIRST_TOKEN_TIMEOUT",
  "GENERATION_TIMEOUT",
  "INVALID_RESPONSE_SHAPE",
  "RUNTIME_UNREACHABLE",
  "MODEL_NOT_LOADED",
  "CONTEXT_REJECTED",
] as const;

export type DiagnosticClassification = (typeof DIAGNOSTIC_CLASSIFICATIONS)[number];

export const REASONING_SOURCES = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
  "inline",
] as const;

export type ReasoningSource = (typeof REASONING_SOURCES)[number];

export interface ResponseAnatomy {
  readonly content: string;
  readonly reasoning: string;
  /** Which key carried it: "reasoning_content" | "reasoning" | "reasoning_text" | "inline" | null. */
  readonly reasoning_source: ReasoningSource | null;
  readonly inlined_reasoning: string;
  readonly reasoning_merged_into_content: boolean;
  readonly tool_call_count: number;
  readonly finish_reason: string | null;
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly shape: "openai_chat" | "unknown";
  readonly observed_fields: readonly string[];
}

export interface RuntimeIdentity {
  readonly base_url: string;
  readonly engine: Backend | string | null;
  readonly engine_image: string | null;
  readonly server_model_ids: readonly string[];
  readonly reachable: boolean;
}

export interface ModelIdentity {
  readonly requested: string;
  readonly served_as: string | null;
  readonly max_model_len: number | null;
  readonly matched: boolean;
}

export interface ProbeHttpResult {
  readonly status: number | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly abort_stage: "connect" | "first_token" | "generation" | null;
}

export interface DiagnosticTiming {
  readonly ttft_ms: number | null;
  readonly total_ms: number;
  readonly generation_ms: number | null;
  readonly tokens_per_second: number | null;
  readonly timed_tokens: number | null;
}

export interface DiagnosticDialectCheck {
  readonly engine: string | null;
  readonly expected_reasoning_source: ReasoningSource | null;
  readonly expected_bounded_output_field: string;
  readonly observed_reasoning_source: ReasoningSource | null;
  readonly reasoning_source_matched: boolean | null;
  readonly bounded_output_field_matched: boolean | null;
  readonly mismatches: readonly string[];
}

export interface DiagnosticReportRequest {
  readonly bounded_output_field: "max_completion_tokens" | "max_tokens";
  readonly bounded_output_reason: string;
  readonly streamed: boolean;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface DiagnosticReport {
  readonly schema_version: "1";
  readonly probed_at: string;
  readonly runtime: RuntimeIdentity;
  readonly model: ModelIdentity;
  readonly request_profile: DiagnosticProfile;
  /** Exactly what was sent, so a rejected request can be diagnosed from the report alone. */
  readonly request: DiagnosticReportRequest;
  readonly http: ProbeHttpResult;
  readonly timing: DiagnosticTiming;
  readonly result: {
    readonly classification: DiagnosticClassification;
    readonly finish_reason: string | null;
    readonly content_length: number;
    readonly reasoning_length: number;
    readonly inlined_reasoning_length: number;
    readonly completion_tokens: number | null;
    readonly reasoning_tokens: number | null;
    readonly reasoning_consumed_budget: boolean | null;
    readonly bounded_output_viable: boolean;
    readonly grounded_answer_match: boolean | null;
  };
  readonly reasoning: {
    readonly budget: ReasoningBudgetResolution;
    readonly separation: ReasoningSeparationResolution;
  };
  readonly anatomy: ResponseAnatomy | null;
  /** Live check of the declared engine's documented dialect against what arrived. */
  readonly dialect: DiagnosticDialectCheck;
  readonly evidence: readonly string[];
}

export interface RecipeIncompatibility {
  readonly id: string;
  readonly detail: string;
  readonly blocks: DiagnosticProfileName | null;
}

export interface RecipeQualificationEvidence {
  readonly schema_version: "1";
  readonly model: {
    readonly model_path: string;
    readonly served_model_name: string | null;
    readonly quantization: string | null;
    readonly dtype: string | null;
    readonly context_tokens: number | null;
  };
  readonly engine: {
    readonly backend: Backend;
    readonly runtime_kind: string;
    readonly runtime_ref: string | null;
  };
  readonly bounded_output: {
    readonly max_input_tokens: number;
    readonly max_output_tokens: number;
    readonly temperature: number;
    readonly timeout_ms: number;
    readonly stream: boolean;
  };
  readonly reasoning: ReasoningBudgetResolution;
  readonly known_incompatibilities: readonly RecipeIncompatibility[];
  readonly diagnostics: readonly {
    readonly profile: DiagnosticProfileName;
    readonly classification: DiagnosticClassification;
    readonly probed_at: string;
  }[];
}