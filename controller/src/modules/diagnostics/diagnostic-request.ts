import type {
  DiagnosticProfile,
  ReasoningBudgetResolution,
} from "@local-studio/contracts/inference-diagnostics";
import { ensureStreamingUsageIncluded } from "../proxy/chat-request";

type Rec = Record<string, unknown>;

const COMPLETION_BOUNDED_ENGINES = new Set(["vllm", "sglang"]);

export interface BoundedOutputField {
  readonly field: "max_completion_tokens" | "max_tokens";
  readonly reason: string;
}

export const boundedOutputField = (engine: string | null): BoundedOutputField => {
  if (engine && COMPLETION_BOUNDED_ENGINES.has(engine)) {
    return {
      field: "max_completion_tokens",
      reason: `${engine} is driven with max_completion_tokens; max_tokens is deprecated on that surface.`,
    };
  }
  if (!engine) {
    return {
      field: "max_completion_tokens",
      reason:
        "No engine was declared, so the OpenAI-current bounded output field is used. Pass the engine to pick the field this runtime actually reads.",
    };
  }
  return {
    field: "max_tokens",
    reason: `${engine} reads the classic max_tokens bound.`,
  };
};

export interface DiagnosticRequestBody {
  readonly body: Rec;
  readonly bounded_output: BoundedOutputField;
  /** True when a reasoning budget actually reached the wire. */
  readonly reasoning_budget_sent: boolean;
}

/**
 * Sends the reasoning budget only where the engine declared a real per-request
 * equivalent. A server-side flag cannot be set from a request, so claiming
 * SUPPORTED and then sending nothing would be an unfalsifiable claim.
 */
const applyReasoningBudget = (
  body: Rec,
  budget: ReasoningBudgetResolution | null,
): boolean => {
  if (
    budget === null ||
    !budget.applies_to_request ||
    budget.request_field === null ||
    budget.requested === null
  ) {
    return false;
  }
  body[budget.request_field] = budget.requested;
  return true;
};

export const buildDiagnosticRequestBody = ({
  profile,
  model,
  engine,
  reasoningBudget = null,
}: {
  profile: DiagnosticProfile;
  model: string;
  engine: string | null;
  reasoningBudget?: ReasoningBudgetResolution | null;
}): DiagnosticRequestBody => {
  const bound = boundedOutputField(engine);
  const body: Rec = {
    model,
    messages: [{ role: "user", content: profile.prompt }],
    [bound.field]: profile.max_output_tokens,
    temperature: profile.temperature,
    top_p: profile.top_p,
    stream: profile.stream,
  };
  if (profile.stop.length > 0) body["stop"] = [...profile.stop];
  const reasoning_budget_sent = applyReasoningBudget(body, reasoningBudget);
  if (profile.stream) ensureStreamingUsageIncluded(body);
  return { body, bounded_output: bound, reasoning_budget_sent };
};

export const groundedAnswerMatches = (
  profile: DiagnosticProfile,
  content: string,
): boolean | null => {
  if (!profile.expect_grounded_answer || profile.expected_answer === null) return null;
  return content
    .toUpperCase()
    .includes(profile.expected_answer.toUpperCase());
};