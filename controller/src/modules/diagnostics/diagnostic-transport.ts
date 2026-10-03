import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import type { DiagnosticProfile } from "@local-studio/contracts/inference-diagnostics";
import type { ReasoningSource } from "@local-studio/contracts/inference-diagnostics";
import { REASONING_FIELDS } from "../proxy/reasoning";
import { catalogFromPayload, emptyCatalog, type ModelCatalog } from "./runtime-identity";

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type AbortStage = "connect" | "first_token" | "generation";

export interface TransportAttempt {
  readonly status: number | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly error_detail: string | null;
  readonly abort_stage: AbortStage | null;
  readonly ttft_ms: number | null;
  readonly total_ms: number;
  readonly frames: number;
  readonly stream_observed: boolean;
  readonly assembled: unknown;
}

interface Accumulator {
  content: string;
  reasoning: string;
  /**
   * Distinct tool-call identifiers seen so far. A streamed call arrives as one
   * frame carrying its id and name followed by further frames carrying argument
   * fragments, all keyed by the same `index`, so counting entries per frame
   * would report one call as however many argument chunks it took.
   */
  toolCallKeys: Set<string>;
  /**
   * Which key the runtime actually used. vLLM reports `reasoning` while
   * llama-server and SGLang report `reasoning_content`, and folding them into
   * one field would erase the only evidence of which dialect is speaking.
   */
  reasoningSource: ReasoningSource | null;
  finishReason: string | null;
  usage: Rec | null;
  frames: number;
  sawFinishReason: boolean;
}

const emptyAccumulator = (): Accumulator => ({
  content: "",
  reasoning: "",
  toolCallKeys: new Set(),
  reasoningSource: null,
  finishReason: null,
  usage: null,
  frames: 0,
  sawFinishReason: false,
});

const toolCallKey = (call: unknown, position: number): string => {
  if (isRec(call)) {
    if (typeof call["index"] === "number") return `index:${call["index"]}`;
    if (typeof call["id"] === "string" && call["id"] !== "") return `id:${call["id"]}`;
  }
  return `frame:${position}`;
};

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

const authHeaders = (apiKey: string | null): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
});

const errorMessage = (source: unknown): string =>
  source instanceof Error ? source.message : String(source);

const deltaText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  let joined = "";
  for (const part of value) {
    if (typeof part === "string") joined += part;
    else if (isRec(part) && typeof part["text"] === "string") joined += part["text"];
  }
  return joined;
};

const frameReasoning = (delta: Rec): { readonly field: ReasoningSource; readonly text: string } | null => {
  for (const field of REASONING_FIELDS) {
    const value = delta[field];
    if (typeof value === "string" && value.length > 0) return { field, text: value };
  }
  return null;
};

const mergeFrame = (accumulator: Accumulator, payload: unknown): void => {
  if (!isRec(payload)) return;
  accumulator.frames += 1;
  if (isRec(payload["usage"]) && Object.keys(payload["usage"]).length > 0) {
    accumulator.usage = payload["usage"];
  }
  const choices = payload["choices"];
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!isRec(choice)) continue;
    if (typeof choice["finish_reason"] === "string" && choice["finish_reason"]) {
      accumulator.finishReason = choice["finish_reason"];
      accumulator.sawFinishReason = true;
    }
    const delta = isRec(choice["delta"])
      ? choice["delta"]
      : isRec(choice["message"])
        ? choice["message"]
        : null;
    if (!delta) continue;
    accumulator.content += deltaText(delta["content"]);
    const reasoning = frameReasoning(delta);
    if (reasoning !== null) {
      accumulator.reasoningSource ??= reasoning.field;
      accumulator.reasoning += reasoning.text;
    }
    const calls = delta["tool_calls"];
    if (Array.isArray(calls)) {
      calls.forEach((call, position) => accumulator.toolCallKeys.add(toolCallKey(call, position)));
    }
  }
};

const assembledBody = (accumulator: Accumulator): Rec => {
  const message: Rec = { role: "assistant", content: accumulator.content };
  if (accumulator.reasoning) {
    message[accumulator.reasoningSource ?? "reasoning_content"] = accumulator.reasoning;
  }
  if (accumulator.toolCallKeys.size > 0) {
    message["tool_calls"] = Array.from({ length: accumulator.toolCallKeys.size }, (_, index) => ({
      index,
      type: "function",
    }));
  }
  return {
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: accumulator.finishReason }],
    ...(accumulator.usage ? { usage: accumulator.usage } : {}),
  };
};

const jsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export const readModelCatalog = ({
  baseUrl,
  apiKey,
  timeoutMs,
}: {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
}): Effect.Effect<ModelCatalog> =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(joinUrl(baseUrl, "/v1/models"), {
          method: "GET",
          headers: authHeaders(apiKey),
          signal: controller.signal,
        });
        let text = "";
        try {
          text = await response.text();
        } catch {
          text = "";
        }
        return catalogFromPayload(jsonOrNull(text), response.ok);
      } catch {
        return emptyCatalog();
      } finally {
        clearTimeout(timer);
      }
    },
    catch: errorMessage,
  }).pipe(Effect.orDie);

export const attemptDiagnosticRequest = (options: {
  baseUrl: string;
  apiKey: string | null;
  body: Rec;
  profile: DiagnosticProfile;
}): Effect.Effect<TransportAttempt> =>
  Effect.tryPromise({
    try: async () => {
      const { baseUrl, apiKey, body, profile } = options;
      const started = performance.now();
      const controller = new AbortController();
      let abortStage: AbortStage | null = null;
      const stage = (): AbortStage | null => abortStage;
      let ttftMs: number | null = null;

      const elapsed = (): number => Math.max(0, Math.round(performance.now() - started));

      const firstTokenTimer = setTimeout(() => {
        if (ttftMs === null) abortStage = "first_token";
        controller.abort();
      }, profile.first_token_timeout_ms);
      const totalTimer = setTimeout(() => {
        if (abortStage !== "first_token") abortStage = "generation";
        controller.abort();
      }, profile.timeout_ms);

      const markFirstToken = (): void => {
        if (ttftMs !== null) return;
        ttftMs = elapsed();
        clearTimeout(firstTokenTimer);
      };

      try {
        const response = await fetch(joinUrl(baseUrl, "/v1/chat/completions"), {
          method: "POST",
          headers: authHeaders(apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let detail = "";
          try {
            detail = await response.text();
          } catch {
            detail = "";
          }
          return {
            status: response.status,
            ok: false,
            error: `runtime responded ${response.status}`,
            error_detail: detail.slice(0, 2_000),
            abort_stage: stage(),
            ttft_ms: null,
            total_ms: elapsed(),
            frames: 0,
            stream_observed: false,
            assembled: null,
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        const streaming = profile.stream && contentType.includes("text/event-stream");

        if (!streaming || !response.body) {
          let text = "";
          try {
            text = await response.text();
          } catch {
            text = "";
          }
          if (!profile.stream) markFirstToken();
          return {
            status: response.status,
            ok: true,
            error: null,
            error_detail: null,
            abort_stage: stage(),
            ttft_ms: ttftMs,
            total_ms: elapsed(),
            frames: 1,
            stream_observed: false,
            assembled: jsonOrNull(text),
          };
        }

        const accumulator = emptyAccumulator();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line.startsWith("data:")) continue;
            const payloadText = line.slice(5).trim();
            if (!payloadText || payloadText === "[DONE]") continue;
            const payload = jsonOrNull(payloadText);
            if (payload === null) continue;
            markFirstToken();
            mergeFrame(accumulator, payload);
          }
        }

        return {
          status: response.status,
          ok: true,
          error: null,
          error_detail: null,
          abort_stage: stage(),
          ttft_ms: ttftMs,
          total_ms: elapsed(),
          frames: accumulator.frames,
          stream_observed: true,
          assembled: assembledBody(accumulator),
        };
      } catch (error) {
        return {
          status: null,
          ok: false,
          error: errorMessage(error),
          error_detail: null,
          abort_stage: stage() ?? "connect",
          ttft_ms: ttftMs,
          total_ms: elapsed(),
          frames: 0,
          stream_observed: false,
          assembled: null,
        };
      } finally {
        clearTimeout(firstTokenTimer);
        clearTimeout(totalTimer);
      }
    },
    catch: (source) => new Error(`diagnostic transport failed: ${errorMessage(source)}`),
  }).pipe(Effect.orDie);