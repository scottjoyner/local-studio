import type { DiagnosticProfile } from "@local-studio/contracts/inference-diagnostics";
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
}

export const buildDiagnosticRequestBody = ({
  profile,
  model,
  engine,
}: {
  profile: DiagnosticProfile;
  model: string;
  engine: string | null;
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
  if (profile.stream) ensureStreamingUsageIncluded(body);
  return { body, bounded_output: bound };
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