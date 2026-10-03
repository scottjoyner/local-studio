import type { Backend } from "@local-studio/contracts/recipes";
import type {
  ReasoningBudgetResolution,
  ReasoningBudgetMechanism,
  ReasoningBudgetState,
  ReasoningSeparationResolution,
} from "@local-studio/contracts/inference-diagnostics";

interface EngineReasoningSupport {
  readonly budget_state: ReasoningBudgetState;
  readonly budget_mechanism: ReasoningBudgetMechanism;
  readonly budget_engine_flag: string | null;
  readonly budget_request_field: string | null;
  readonly budget_detail: string;
  readonly separation_state: ReasoningBudgetState;
  readonly separation_mechanism: ReasoningBudgetMechanism;
  readonly separation_engine_flag: string | null;
  readonly separation_request_field: string | null;
  readonly separation_detail: string;
}

const serverFlagBudget = (
  flag: string,
  detail: string,
): Pick<
  EngineReasoningSupport,
  | "budget_state"
  | "budget_mechanism"
  | "budget_engine_flag"
  | "budget_request_field"
  | "budget_detail"
> => ({
  budget_state: "SUPPORTED",
  budget_mechanism: "server_flag",
  budget_engine_flag: flag,
  budget_request_field: null,
  budget_detail: detail,
});

const serverFlagSeparation = (
  flag: string,
  detail: string,
): Pick<
  EngineReasoningSupport,
  | "separation_state"
  | "separation_mechanism"
  | "separation_engine_flag"
  | "separation_request_field"
  | "separation_detail"
> => ({
  separation_state: "SUPPORTED",
  separation_mechanism: "server_flag",
  separation_engine_flag: flag,
  separation_request_field: null,
  separation_detail: detail,
});

const unsupportedBudget = (detail: string): Pick<
  EngineReasoningSupport,
  | "budget_state"
  | "budget_mechanism"
  | "budget_engine_flag"
  | "budget_request_field"
  | "budget_detail"
> => ({
  budget_state: "UNSUPPORTED",
  budget_mechanism: "none",
  budget_engine_flag: null,
  budget_request_field: null,
  budget_detail: detail,
});

const unsupportedSeparation = (detail: string): Pick<
  EngineReasoningSupport,
  | "separation_state"
  | "separation_mechanism"
  | "separation_engine_flag"
  | "separation_request_field"
  | "separation_detail"
> => ({
  separation_state: "UNSUPPORTED",
  separation_mechanism: "none",
  separation_engine_flag: null,
  separation_request_field: null,
  separation_detail: detail,
});

const NO_BUDGET_FLAG =
  "The engine exposes no reasoning token budget. Bounding the output cap is the only available control, which is why a reasoning model can still return no final content.";

const SUPPORT: Readonly<Record<Backend, EngineReasoningSupport>> = {
  llamacpp: {
    ...serverFlagBudget(
      "--reasoning-budget",
      "llama-server bounds reasoning with --reasoning-budget. The value is fixed when the server starts, so a request against an already-running runtime cannot change it.",
    ),
    ...serverFlagSeparation(
      "--reasoning-format",
      "llama-server splits reasoning out of content when --reasoning-format names a dialect the template emits. Without it, thoughts arrive inside content.",
    ),
  },
  vllm: {
    ...unsupportedBudget(NO_BUDGET_FLAG),
    ...serverFlagSeparation(
      "--reasoning-parser",
      "vLLM moves a recognized reasoning span out of content into reasoning_content. It controls where reasoning is reported, not how much is generated.",
    ),
  },
  sglang: {
    ...unsupportedBudget(NO_BUDGET_FLAG),
    ...serverFlagSeparation(
      "--reasoning-parser",
      "SGLang moves a recognized reasoning span out of content into reasoning_content. It controls where reasoning is reported, not how much is generated.",
    ),
  },
  mlx: {
    ...unsupportedBudget(NO_BUDGET_FLAG),
    ...unsupportedSeparation(
      "mlx_lm.server is launched with no reasoning flags by this controller, so reasoning is never split out of content.",
    ),
  },
};

const ENGINE_ONLY_SUPPORT: Readonly<Record<string, EngineReasoningSupport>> = {
  exllamav3: {
    ...unsupportedBudget(NO_BUDGET_FLAG),
    ...unsupportedSeparation(
      "TabbyAPI is configured through config.yml and this controller passes it no reasoning flags, so reasoning is never split out of content.",
    ),
  },
};

const UNKNOWN_ENGINE: EngineReasoningSupport = {
  ...unsupportedBudget(NO_BUDGET_FLAG),
  ...unsupportedSeparation(
    "No reasoning separation is known for this engine, so reasoning is expected to arrive inside content.",
  ),
};

const invalid = (detail: string): ReasoningBudgetResolution => ({
  field: "max_thinking_tokens",
  requested: null,
  state: "INVALID_CONFIGURATION",
  mechanism: "none",
  engine_flag: null,
  request_field: null,
  applies_to_request: false,
  compared_against_output_cap: null,
  detail,
});

const budgetInvalidity = (
  requested: number,
  maxOutputTokens: number | null,
): string | null => {
  if (!Number.isInteger(requested)) {
    return `max_thinking_tokens ${requested} is not an integer; the field counts tokens.`;
  }
  if (requested < 0) {
    return `max_thinking_tokens ${requested} is negative; a token budget cannot be negative.`;
  }
  if (maxOutputTokens !== null && requested > maxOutputTokens) {
    return `max_thinking_tokens ${requested} exceeds the output cap ${maxOutputTokens}, leaving no room for a final answer.`;
  }
  return null;
};

export const reasoningSeparationFor = (engine: string | null): ReasoningSeparationResolution => {
  const support = supportFor(engine);
  return {
    state: support.separation_state,
    mechanism: support.separation_mechanism,
    engine_flag: support.separation_engine_flag,
    request_field: support.separation_request_field,
    detail: support.separation_detail,
  };
};

const supportFor = (engine: string | null): EngineReasoningSupport => {
  if (!engine) return UNKNOWN_ENGINE;
  if (Object.hasOwn(SUPPORT, engine)) return SUPPORT[engine as Backend];
  if (Object.hasOwn(ENGINE_ONLY_SUPPORT, engine)) return ENGINE_ONLY_SUPPORT[engine]!;
  return UNKNOWN_ENGINE;
};

export const resolveReasoningBudget = ({
  engine,
  requested,
  maxOutputTokens,
}: {
  engine: string | null;
  requested: number | null;
  maxOutputTokens: number | null;
}): ReasoningBudgetResolution => {
  if (requested !== null) {
    const problem = budgetInvalidity(requested, maxOutputTokens);
    if (problem) return invalid(problem);
  }
  const support = supportFor(engine);
  return {
    field: "max_thinking_tokens",
    requested,
    compared_against_output_cap: maxOutputTokens,
    state: support.budget_state,
    mechanism: support.budget_mechanism,
    engine_flag: support.budget_engine_flag,
    request_field: support.budget_request_field,
    applies_to_request: support.budget_mechanism === "request_field",
    detail: support.budget_detail,
  };
};

export const observeReasoningSeparation = (
  resolution: ReasoningSeparationResolution,
  observation: { requested: boolean; separated: boolean },
): ReasoningSeparationResolution => {
  if (!observation.requested || observation.separated) return resolution;
  if (resolution.state === "UNSUPPORTED") return resolution;
  return {
    ...resolution,
    state: "IGNORED_BY_ENGINE",
    detail: `The runtime answered 200 but the reasoning never reached its own field, so ${resolution.engine_flag ?? "the configured directive"} had no effect on this request.`,
  };
};