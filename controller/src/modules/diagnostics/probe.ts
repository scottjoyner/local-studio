import { Effect } from "effect";
import type {
  DiagnosticProfile,
  DiagnosticReport,
  ReasoningBudgetResolution,
  ReasoningSeparationResolution,
} from "@local-studio/contracts/inference-diagnostics";
import { buildDiagnosticRequestBody, groundedAnswerMatches } from "./diagnostic-request";
import { attemptDiagnosticRequest, readModelCatalog } from "./diagnostic-transport";
import { readResponseAnatomy } from "./response-anatomy";
import {
  boundedOutputViable,
  classifyDiagnostic,
  reasoningConsumedBudget,
} from "./classification";
import {
  observeReasoningSeparation,
  reasoningSeparationFor,
  resolveReasoningBudget,
} from "./reasoning-support";
import {
  DiagnosticProfileError,
  modelIdentityFrom,
  profileBoundsProblem,
  runtimeIdentityFrom,
} from "./runtime-identity";

export interface QualificationProbeInput {
  readonly base_url: string;
  readonly model: string;
  readonly profile: DiagnosticProfile;
  readonly engine: string | null;
  readonly engine_image: string | null;
  readonly api_key: string | null;
  readonly probed_at: string;
}

const CATALOG_TIMEOUT_MS = 5_000;

const MIN_RATE_WINDOW_MS = 10;

const tokensPerSecond = (
  completionTokens: number | null,
  ttftMs: number | null,
  totalMs: number,
): number | null => {
  if (completionTokens === null || completionTokens <= 0) return null;
  const generationMs = totalMs - (ttftMs ?? 0);
  if (generationMs < MIN_RATE_WINDOW_MS) return null;
  return Math.round((completionTokens / (generationMs / 1_000)) * 10) / 10;
};

const evidence = (lines: readonly string[]): readonly string[] => lines.filter((line) => line !== "");

export const runQualificationProbe = (
  input: QualificationProbeInput,
): Effect.Effect<DiagnosticReport, DiagnosticProfileError> =>
  Effect.gen(function* () {
    const boundsProblem = profileBoundsProblem(input.profile);
    if (boundsProblem !== null) {
      return yield* Effect.fail(
        new DiagnosticProfileError({ profile: input.profile.name, detail: boundsProblem }),
      );
    }

    const catalog = yield* readModelCatalog({
      baseUrl: input.base_url,
      apiKey: input.api_key,
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    const runtime = runtimeIdentityFrom(input.base_url, catalog, input.engine);
    const model = modelIdentityFrom(catalog, input.model);

    const budget: ReasoningBudgetResolution = resolveReasoningBudget({
      engine: input.engine,
      requested: input.profile.reasoning_budget_tokens,
      maxOutputTokens: input.profile.max_output_tokens,
    });
    const separation: ReasoningSeparationResolution = reasoningSeparationFor(input.engine);

    const { body, bounded_output } = buildDiagnosticRequestBody({
      profile: input.profile,
      model: input.model,
      engine: input.engine,
    });

    const attempt = yield* attemptDiagnosticRequest({
      baseUrl: input.base_url,
      apiKey: input.api_key,
      body,
      profile: input.profile,
    });

    const anatomy =
      attempt.assembled === null ? null : readResponseAnatomy(attempt.assembled);

    const outcome = classifyDiagnostic({
      http: {
        status: attempt.status,
        ok: attempt.ok,
        error: attempt.error,
        abort_stage: attempt.abort_stage,
      },
      anatomy,
      error_detail: attempt.error_detail,
    });

    const resolvedSeparation = observeReasoningSeparation(separation, {
      separated: anatomy !== null && !anatomy.reasoning_merged_into_content,
      responded: attempt.ok && anatomy !== null,
    });
    const consumed = reasoningConsumedBudget(anatomy);

    const notes = evidence([
      ...outcome.evidence,
      bounded_output.reason,
      `reasoning budget state ${budget.state}: ${budget.detail}`,
      catalog.reachable ? "" : "GET /v1/models did not answer; identity came from the completion response alone.",
      model.matched ? "" : `model id ${input.model} is not in /v1/models.`,
      attempt.stream_observed ? "" : "the runtime answered a streaming request with a single JSON body, so no first-token time is observable",
      attempt.stream_observed && anatomy !== null && anatomy.finish_reason === null
        ? "the stream closed without a finish_reason frame, so the turn may be incomplete even though content arrived"
        : "",
    ]);

    return {
      schema_version: "1",
      probed_at: input.probed_at,
      runtime: { ...runtime, engine_image: input.engine_image },
      model,
      request_profile: input.profile,
      request: {
        bounded_output_field: bounded_output.field,
        bounded_output_reason: bounded_output.reason,
        streamed: Boolean(body["stream"]),
        body,
      },
      http: {
        status: attempt.status,
        ok: attempt.ok,
        error: attempt.error,
        abort_stage: attempt.abort_stage,
      },
      timing: {
        ttft_ms: attempt.ttft_ms,
        total_ms: attempt.total_ms,
        generation_ms:
          attempt.ttft_ms === null ? null : Math.max(0, attempt.total_ms - attempt.ttft_ms),
        tokens_per_second: tokensPerSecond(
          anatomy?.completion_tokens ?? null,
          attempt.ttft_ms,
          attempt.total_ms,
        ),
        timed_tokens: anatomy?.completion_tokens ?? null,
      },
      result: {
        classification: outcome.classification,
        finish_reason: anatomy?.finish_reason ?? null,
        content_length: anatomy?.content.length ?? 0,
        reasoning_length: anatomy?.reasoning.length ?? 0,
        inlined_reasoning_length: anatomy?.inlined_reasoning.length ?? 0,
        completion_tokens: anatomy?.completion_tokens ?? null,
        reasoning_tokens: anatomy?.reasoning_tokens ?? null,
        reasoning_consumed_budget: consumed,
        bounded_output_viable: boundedOutputViable(outcome.classification),
        grounded_answer_match: anatomy
          ? groundedAnswerMatches(input.profile, anatomy.content)
          : null,
      },
      reasoning: { budget, separation: resolvedSeparation },
      anatomy,
      evidence: notes,
    };
  });