import type {
  DiagnosticClassification,
  ResponseAnatomy,
} from "@local-studio/contracts/inference-diagnostics";
import type { ProbeHttpResult } from "@local-studio/contracts/inference-diagnostics";

const CONTEXT_REJECTION_MARKERS = [
  "maximum context length",
  "reduce the length",
  "context length",
  "exceeds the available context",
  "exceeds context size",
  "requested tokens exceed",
  "too many tokens",
  "longer than the model",
] as const;

const looksLikeContextRejection = (detail: string | null): boolean => {
  if (!detail) return false;
  const haystack = detail.toLowerCase();
  return CONTEXT_REJECTION_MARKERS.some((marker) => haystack.includes(marker));
};

const trimmed = (value: string): string => value.trim();

export interface ClassificationInput {
  readonly http: ProbeHttpResult;
  readonly anatomy: ResponseAnatomy | null;
  readonly error_detail: string | null;
}

export interface ClassificationOutcome {
  readonly classification: DiagnosticClassification;
  readonly evidence: readonly string[];
}

const push = (evidence: string[], line: string): void => {
  evidence.push(line);
};

export const classifyDiagnostic = ({
  http,
  anatomy,
  error_detail: errorDetail,
}: ClassificationInput): ClassificationOutcome => {
  const evidence: string[] = [];

  if (http.abort_stage === "first_token") {
    push(evidence, "Connection and response headers arrived but no token was emitted in time.");
    return { classification: "FIRST_TOKEN_TIMEOUT", evidence };
  }
  if (http.abort_stage === "generation") {
    push(evidence, "Generation started and was still running when the wall timeout elapsed.");
    return { classification: "GENERATION_TIMEOUT", evidence };
  }
  if (!http.ok && http.status === null) {
    push(evidence, `No HTTP response was received: ${http.error ?? "transport failure"}.`);
    return { classification: "MODEL_NOT_LOADED", evidence };
  }
  if (http.status === 404 || http.status === 503) {
    push(evidence, `Runtime answered ${http.status}; the requested model is not served here.`);
    return { classification: "MODEL_NOT_LOADED", evidence };
  }
  if (http.status === 400 && looksLikeContextRejection(errorDetail)) {
    push(evidence, "Runtime rejected the prompt as too long for this context window.");
    return { classification: "CONTEXT_REJECTED", evidence };
  }
  if (!http.ok) {
    push(
      evidence,
      `Runtime answered ${http.status} for a conformant bounded request: ${errorDetail ?? http.error ?? "no detail"}.`,
    );
    return { classification: "INVALID_RESPONSE_SHAPE", evidence };
  }
  if (!anatomy || anatomy.shape !== "openai_chat") {
    push(
      evidence,
      `Response body carried no OpenAI chat choices; fields observed: ${anatomy?.observed_fields.join(", ") || "none"}.`,
    );
    return { classification: "INVALID_RESPONSE_SHAPE", evidence };
  }

  if (anatomy.finish_reason === "length") {
    push(
      evidence,
      anatomy.reasoning.length > 0
        ? `finish_reason=length with ${anatomy.reasoning.length} reasoning characters, so reasoning absorbed the output budget.`
        : "finish_reason=length, so the response was cut at the output cap.",
    );
    return { classification: "LENGTH_TRUNCATED", evidence };
  }
  if (trimmed(anatomy.content).length === 0) {
    if (anatomy.reasoning.trim().length > 0) {
      push(
        evidence,
        `Final content was empty while ${anatomy.reasoning.length} reasoning characters were produced.`,
      );
      return { classification: "REASONING_ONLY", evidence };
    }
    push(evidence, "Response carried neither final content nor reasoning.");
    return { classification: "EMPTY_FINAL_CONTENT", evidence };
  }

  push(
    evidence,
    anatomy.reasoning_merged_into_content
      ? `Final content is ${anatomy.content.length} characters and still contains inline reasoning.`
      : `Final content is ${anatomy.content.length} characters.`,
  );
  return { classification: "OUTPUT_OK", evidence };
};

export const reasoningConsumedBudget = (anatomy: ResponseAnatomy | null): boolean | null => {
  if (!anatomy || anatomy.shape !== "openai_chat") return null;
  if (anatomy.finish_reason !== "length") return false;
  return (
    anatomy.reasoning.trim().length > 0 || (anatomy.reasoning_tokens ?? 0) > 0
  );
};

export const boundedOutputViable = (classification: DiagnosticClassification): boolean =>
  classification === "OUTPUT_OK";