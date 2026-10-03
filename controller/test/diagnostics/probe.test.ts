import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { DiagnosticProfile, DiagnosticReport } from "@local-studio/contracts/inference-diagnostics";
import { runQualificationProbe } from "../../src/modules/diagnostics/probe";
import { diagnosticProfile } from "../../src/modules/diagnostics/diagnostic-profiles";

const PROBED_AT = "2026-10-02T00:00:00.000Z";
const MODEL_ID = "Ternary-Bonsai-2-27B-PQ2_0";

const sseFrame = (payload: Record<string, unknown>): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);

const deltaFrame = (content: string, extra: Record<string, unknown> = {}): Uint8Array =>
  sseFrame({ choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] });

const finishFrame = (finishReason: string): Uint8Array =>
  sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });

const usageFrame = (completion: number, reasoning: number | null): Uint8Array =>
  sseFrame({
    choices: [],
    usage: {
      prompt_tokens: 24,
      completion_tokens: completion,
      completion_tokens_details: reasoning === null ? {} : { reasoning_tokens: reasoning },
    },
  });

type Handler = (request: Request) => Response | Promise<Response>;

const openStream = (chunks: readonly Uint8Array[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const stallStream = (prefix: readonly Uint8Array[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (const chunk of prefix) controller.enqueue(chunk);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const probe = async (handler: Handler, profile: DiagnosticProfile): Promise<DiagnosticReport> => {
  const server = Bun.serve({ port: 0, fetch: handler });
  try {
    return await Effect.runPromise(
      runQualificationProbe({
        base_url: `http://127.0.0.1:${server.port}`,
        model: MODEL_ID,
        profile,
        engine: "llamacpp",
        engine_image: "ghcr.io/ggml-org/llama.cpp:server-rocm",
        api_key: null,
        probed_at: PROBED_AT,
      }),
    );
  } finally {
    server.stop(true);
  }
};

const withModelCatalog = (handler: Handler): Handler => (request) => {
  if (new URL(request.url).pathname === "/v1/models") {
    return Response.json({
      object: "list",
      data: [{ id: MODEL_ID, object: "model", owned_by: "local-studio", max_model_len: 32_768 }],
    });
  }
  return handler(request);
};

const fastProfile = (
  overrides: Partial<DiagnosticProfile> = {},
): DiagnosticProfile => {
  const base = diagnosticProfile("protocol_canary");
  if (!base) throw new Error("protocol_canary profile is missing");
  return {
    ...base,
    timeout_ms: 1_200,
    first_token_timeout_ms: 400,
    ...overrides,
  };
};

test("a runtime that answers with a real final message is OUTPUT_OK", async () => {
  const report = await probe(
    withModelCatalog(() =>
      openStream([deltaFrame("OK"), finishFrame("stop"), usageFrame(2, null)]),
    ),
    fastProfile(),
  );
  expect(report.result.classification).toBe("OUTPUT_OK");
  expect(report.result.content_length).toBe(2);
  expect(report.result.finish_reason).toBe("stop");
  expect(report.result.bounded_output_viable).toBe(true);
  expect(report.result.grounded_answer_match).toBe(true);
  expect(report.model.matched).toBe(true);
  expect(report.model.max_model_len).toBe(32_768);
  expect(report.timing.ttft_ms).not.toBeNull();
  expect(report.timing.tokens_per_second).not.toBeNull();
});

test("a runtime that accepts the connection and never emits a token is FIRST_TOKEN_TIMEOUT", async () => {
  const report = await probe(withModelCatalog(() => stallStream([])), fastProfile());
  expect(report.result.classification).toBe("FIRST_TOKEN_TIMEOUT");
  expect(report.timing.ttft_ms).toBeNull();
  expect(report.http.abort_stage).toBe("first_token");
});

test("a runtime that emits reasoning and then stops at the cap is LENGTH_TRUNCATED", async () => {
  const report = await probe(
    withModelCatalog(() =>
      openStream([
        sseFrame({
          choices: [{ index: 0, delta: { reasoning_content: "thinking hard" }, finish_reason: null }],
        }),
        finishFrame("length"),
        usageFrame(256, 256),
      ]),
    ),
    fastProfile({ max_output_tokens: 256 }),
  );
  expect(report.result.classification).toBe("LENGTH_TRUNCATED");
  expect(report.result.reasoning_length).toBeGreaterThan(0);
  expect(report.result.content_length).toBe(0);
  expect(report.result.reasoning_consumed_budget).toBe(true);
  expect(report.result.bounded_output_viable).toBe(false);
});

test("a runtime that returns only reasoning is REASONING_ONLY", async () => {
  const report = await probe(
    withModelCatalog(() =>
      openStream([
        sseFrame({
          choices: [{ index: 0, delta: { reasoning_content: "still working" }, finish_reason: null }],
        }),
        finishFrame("stop"),
      ]),
    ),
    fastProfile(),
  );
  expect(report.result.classification).toBe("REASONING_ONLY");
});

test("a runtime whose 200 carries no chat choices is INVALID_RESPONSE_SHAPE", async () => {
  const report = await probe(
    withModelCatalog(() => Response.json({ status: "ok", generations: [{ text: "hi" }] })),
    fastProfile(),
  );
  expect(report.result.classification).toBe("INVALID_RESPONSE_SHAPE");
  expect(report.anatomy?.observed_fields).toContain("generations");
});

test("a runtime that refuses the prompt as too long is CONTEXT_REJECTED", async () => {
  const report = await probe(
    withModelCatalog(() =>
      Response.json(
        {
          error: {
            message:
              "This model's maximum context length is 32768 tokens. However, you requested 90000 tokens.",
          },
        },
        { status: 400 },
      ),
    ),
    fastProfile(),
  );
  expect(report.result.classification).toBe("CONTEXT_REJECTED");
});

test("a runtime that does not serve the model is MODEL_NOT_LOADED", async () => {
  const report = await probe(
    withModelCatalog(() => Response.json({ error: { message: "not found" } }, { status: 404 })),
    fastProfile(),
  );
  expect(report.result.classification).toBe("MODEL_NOT_LOADED");
});

test("generation that starts and then overruns the wall budget is GENERATION_TIMEOUT", async () => {
  const report = await probe(
    withModelCatalog(() => stallStream([deltaFrame("partial")])),
    fastProfile(),
  );
  expect(report.result.classification).toBe("GENERATION_TIMEOUT");
  expect(report.http.abort_stage).toBe("generation");
  expect(report.timing.ttft_ms).not.toBeNull();
  expect(report.timing.total_ms).toBeGreaterThanOrEqual(report.timing.ttft_ms ?? 0);
});

test("the probe reads llama.cpp identity and never claims a per-request budget", async () => {
  const report = await probe(
    withModelCatalog(() =>
      openStream([deltaFrame("OK"), finishFrame("stop"), usageFrame(2, null)]),
    ),
    fastProfile(),
  );
  expect(report.runtime.base_url).toContain("127.0.0.1");
  expect(report.runtime.engine).toBe("llamacpp");
  expect(report.runtime.server_model_ids).toEqual([MODEL_ID]);
  expect(report.reasoning.budget.engine_flag).toBe("--reasoning-budget");
  expect(report.reasoning.budget.applies_to_request).toBe(false);
  expect(report.schema_version).toBe("1");
});