import type { ResponseAnatomy } from "@local-studio/contracts/inference-diagnostics";
import { createThinkRewriter, firstReasoningField } from "../proxy/reasoning";

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  let joined = "";
  for (const part of value) {
    if (typeof part === "string") {
      joined += part;
      continue;
    }
    if (!isRec(part)) continue;
    if (part["type"] === "text" || part["type"] === "output_text") {
      joined += stringOrNull(part["text"]) ?? "";
    }
  }
  return joined;
};

const countToolCalls = (message: Rec): number => {
  const calls = message["tool_calls"];
  return Array.isArray(calls) ? calls.length : 0;
};

const splitInlineReasoning = (
  content: string,
): { content: string; inlined: string } => {
  if (!content || !content.includes("<")) return { content, inlined: "" };
  const rewriter = createThinkRewriter();
  const rewritten = rewriter.rewrite(content);
  const carry = rewriter.drainCarry();
  const remainder = rewriter.inThink() ? rewritten.content : rewritten.content + carry;
  const extracted = rewriter.inThink()
    ? rewritten.reasoningAppend + carry
    : rewritten.reasoningAppend;
  if (!extracted) return { content, inlined: "" };
  return { content: remainder, inlined: extracted };
};

const usageTokens = (usage: Rec): {
  prompt: number | null;
  completion: number | null;
  reasoning: number | null;
} => {
  const details = isRec(usage["completion_tokens_details"])
    ? usage["completion_tokens_details"]
    : null;
  return {
    prompt: numberOrNull(usage["prompt_tokens"]),
    completion: numberOrNull(usage["completion_tokens"]),
    reasoning:
      numberOrNull(usage["reasoning_tokens"]) ?? numberOrNull(details?.["reasoning_tokens"]),
  };
};

const unknownAnatomy = (observedFields: readonly string[]): ResponseAnatomy => ({
  content: "",
  reasoning: "",
  inlined_reasoning: "",
  reasoning_merged_into_content: false,
  tool_call_count: 0,
  finish_reason: null,
  prompt_tokens: null,
  completion_tokens: null,
  reasoning_tokens: null,
  shape: "unknown",
  observed_fields: observedFields,
});

export const readResponseAnatomy = (payload: unknown): ResponseAnatomy => {
  if (!isRec(payload)) return unknownAnatomy([]);
  const observedFields = Object.keys(payload).sort();
  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return unknownAnatomy(observedFields);
  }
  const first = choices[0];
  if (!isRec(first)) return unknownAnatomy(observedFields);
  const message = isRec(first["message"])
    ? first["message"]
    : isRec(first["delta"])
      ? first["delta"]
      : null;
  if (!message) return unknownAnatomy(observedFields);

  const rawContent = textOf(message["content"]);
  const inline = splitInlineReasoning(rawContent);
  const separatedReasoning = firstReasoningField(message);
  const tokens = usageTokens(isRec(payload["usage"]) ? payload["usage"] : {});
  const inlined = inline.inlined;
  const reasoning = [separatedReasoning, inlined].filter(Boolean).join("\n");

  return {
    content: inline.content,
    reasoning,
    inlined_reasoning: inlined,
    reasoning_merged_into_content: inlined.length > 0,
    tool_call_count: countToolCalls(message),
    finish_reason: stringOrNull(first["finish_reason"]),
    prompt_tokens: tokens.prompt,
    completion_tokens: tokens.completion,
    reasoning_tokens: tokens.reasoning,
    shape: "openai_chat",
    observed_fields: observedFields,
  };
};