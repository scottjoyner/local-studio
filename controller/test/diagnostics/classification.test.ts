import { expect, test } from "bun:test";
import type {
  DiagnosticClassification,
  ProbeHttpResult,
  ResponseAnatomy,
} from "@local-studio/contracts/inference-diagnostics";
import { classifyDiagnostic, reasoningConsumedBudget } from "../../src/modules/diagnostics/classification";
import { readResponseAnatomy } from "../../src/modules/diagnostics/response-anatomy";

const okHttp: ProbeHttpResult = {
  status: 200,
  ok: true,
  error: null,
  abort_stage: null,
};

const chatCompletion = (
  message: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, unknown>,
): unknown => ({
  object: "chat.completion",
  model: "candidate",
  choices: [{ index: 0, message, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});

const classify = (
  payload: unknown,
): { classification: DiagnosticClassification; anatomy: ResponseAnatomy | null } => {
  const anatomy = payload === undefined ? null : readResponseAnatomy(payload);
  return {
    anatomy,
    classification: classifyDiagnostic({
      http: okHttp,
      anatomy,
      error_detail: null,
    }).classification,
  };
};

test("a normal final answer is OUTPUT_OK", () => {
  const result = classify(
    chatCompletion({ role: "assistant", content: "OK" }, "stop"),
  );
  expect(result.classification).toBe("OUTPUT_OK");
  expect(result.anatomy?.content).toBe("OK");
  expect(result.anatomy?.reasoning).toBe("");
  expect(result.anatomy?.finish_reason).toBe("stop");
});

test("reasoning plus a final answer is OUTPUT_OK and keeps both apart", () => {
  const result = classify(
    chatCompletion(
      {
        role: "assistant",
        content: "0.05",
        reasoning_content: "the bat is 1.05, so the ball is 0.05",
      },
      "stop",
    ),
  );
  expect(result.classification).toBe("OUTPUT_OK");
  expect(result.anatomy?.content).toBe("0.05");
  expect(result.anatomy?.reasoning).toContain("the bat is 1.05");
  expect(result.anatomy?.reasoning_merged_into_content).toBe(false);
});

test("reasoning that absorbs the budget with no final answer never passes as success", () => {
  const result = classify(
    chatCompletion(
      { role: "assistant", content: "", reasoning_content: "x".repeat(4_000) },
      "length",
      { completion_tokens: 256, completion_tokens_details: { reasoning_tokens: 256 } },
    ),
  );
  expect(result.classification).not.toBe("OUTPUT_OK");
  expect(["REASONING_ONLY", "LENGTH_TRUNCATED"]).toContain(result.classification);
  expect(result.classification).toBe("LENGTH_TRUNCATED");
  expect(reasoningConsumedBudget(result.anatomy)).toBe(true);
});

test("reasoning with no final answer and no truncation is REASONING_ONLY", () => {
  const result = classify(
    chatCompletion({ role: "assistant", content: "", reasoning_content: "still thinking" }, "stop"),
  );
  expect(result.classification).toBe("REASONING_ONLY");
  expect(reasoningConsumedBudget(result.anatomy)).toBe(false);
});

test("finish_reason length is LENGTH_TRUNCATED even when content exists", () => {
  const result = classify(
    chatCompletion({ role: "assistant", content: "partial answer" }, "length"),
  );
  expect(result.classification).toBe("LENGTH_TRUNCATED");
});

test("an empty message with neither content nor reasoning is EMPTY_FINAL_CONTENT", () => {
  const result = classify(chatCompletion({ role: "assistant", content: "" }, "stop"));
  expect(result.classification).toBe("EMPTY_FINAL_CONTENT");
});

test("a response with no chat choices is INVALID_RESPONSE_SHAPE", () => {
  const result = classify({ status: "ok", generations: [{ text: "hello" }] });
  expect(result.classification).toBe("INVALID_RESPONSE_SHAPE");
  expect(result.anatomy?.shape).toBe("unknown");
  expect(result.anatomy?.observed_fields).toContain("generations");
});

test("a bare string body is INVALID_RESPONSE_SHAPE", () => {
  const result = classify("hello");
  expect(result.classification).toBe("INVALID_RESPONSE_SHAPE");
});

test("inline thinking is reported as reasoning inside content, not merged away", () => {
  const result = classify(
    chatCompletion(
      { role: "assistant", content: "<think>let me work this out</think>LST-QUAL-4417" },
      "stop",
    ),
  );
  expect(result.classification).toBe("OUTPUT_OK");
  expect(result.anatomy?.content).toBe("LST-QUAL-4417");
  expect(result.anatomy?.inlined_reasoning).toBe("let me work this out");
  expect(result.anatomy?.reasoning_merged_into_content).toBe(true);
});

test("multipart content parts are flattened without dropping the body", () => {
  const result = classify(
    chatCompletion(
      {
        role: "assistant",
        content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }],
      },
      "stop",
    ),
  );
  expect(result.anatomy?.content).toBe("part one part two");
  expect(result.classification).toBe("OUTPUT_OK");
});

test("tool calls are counted without standing in for content", () => {
  const result = classify(
    chatCompletion(
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "add" } }],
      },
      "tool_calls",
    ),
  );
  expect(result.anatomy?.tool_call_count).toBe(1);
  expect(result.classification).toBe("EMPTY_FINAL_CONTENT");
});

test("a stalled first token is FIRST_TOKEN_TIMEOUT", () => {
  expect(
    classifyDiagnostic({
      http: { status: null, ok: false, error: "aborted", abort_stage: "first_token" },
      anatomy: null,
      error_detail: null,
    }).classification,
  ).toBe("FIRST_TOKEN_TIMEOUT");
});

test("generation past the wall budget is GENERATION_TIMEOUT", () => {
  expect(
    classifyDiagnostic({
      http: { status: null, ok: false, error: "aborted", abort_stage: "generation" },
      anatomy: null,
      error_detail: null,
    }).classification,
  ).toBe("GENERATION_TIMEOUT");
});

test("a runtime that answered nothing is RUNTIME_UNREACHABLE, not MODEL_NOT_LOADED", () => {
  const report = classifyDiagnostic({
    http: { status: null, ok: false, error: "connection refused", abort_stage: "connect" },
    anatomy: null,
    error_detail: null,
  });
  expect(report.classification).toBe("RUNTIME_UNREACHABLE");
  // The two failures call for opposite remedies: start the runtime versus load a model.
  expect(report.classification).not.toBe("MODEL_NOT_LOADED");
  expect(report.evidence.join(" ")).toContain("No HTTP response was received");
});

test("a 404 and a 503 both mean the model is not served here", () => {
  for (const status of [404, 503]) {
    expect(
      classifyDiagnostic({
        http: { status, ok: false, error: `runtime responded ${status}`, abort_stage: null },
        anatomy: null,
        error_detail: null,
      }).classification,
    ).toBe("MODEL_NOT_LOADED");
  }
});

test("a context-length refusal is CONTEXT_REJECTED", () => {
  expect(
    classifyDiagnostic({
      http: { status: 400, ok: false, error: "runtime responded 400", abort_stage: null },
      anatomy: null,
      error_detail:
        "This model's maximum context length is 4096 tokens. However, you requested 9000 tokens.",
    }).classification,
  ).toBe("CONTEXT_REJECTED");
});

test("a 400 that is not a context refusal is INVALID_RESPONSE_SHAPE", () => {
  expect(
    classifyDiagnostic({
      http: { status: 400, ok: false, error: "runtime responded 400", abort_stage: null },
      anatomy: null,
      error_detail: "unrecognized request field 'max_completion_tokens'",
    }).classification,
  ).toBe("INVALID_RESPONSE_SHAPE");
});