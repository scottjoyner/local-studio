import type {
  DiagnosticDialectCheck,
  ReasoningSeparationResolution,
  ReasoningSource,
  ResponseAnatomy,
} from "@local-studio/contracts/inference-diagnostics";

interface ExpectedDialect {
  readonly reasoning_source: ReasoningSource | null;
  readonly bounded_output_field: "max_completion_tokens" | "max_tokens";
  readonly reports_reasoning_tokens: boolean | null;
}

/**
 * What each engine is documented to speak. These are claims taken from upstream
 * documentation, not from this codebase, so the probe checks them against a live
 * response rather than trusting them: a mismatch is reported instead of
 * silently tolerated, which is what turns a documentation-derived assumption
 * into evidence on the first real run.
 */
const EXPECTED: Readonly<Record<string, ExpectedDialect>> = {
  vllm: {
    reasoning_source: "reasoning",
    bounded_output_field: "max_completion_tokens",
    reports_reasoning_tokens: null,
  },
  sglang: {
    reasoning_source: "reasoning_content",
    bounded_output_field: "max_completion_tokens",
    reports_reasoning_tokens: null,
  },
  llamacpp: {
    reasoning_source: "reasoning_content",
    bounded_output_field: "max_tokens",
    reports_reasoning_tokens: false,
  },
  mlx: {
    reasoning_source: null,
    bounded_output_field: "max_tokens",
    reports_reasoning_tokens: false,
  },
  exllamav3: {
    reasoning_source: null,
    bounded_output_field: "max_tokens",
    reports_reasoning_tokens: false,
  },
};

const expectationFor = (engine: string | null): ExpectedDialect | null => {
  if (!engine) return null;
  return Object.hasOwn(EXPECTED, engine) ? EXPECTED[engine]! : null;
};

const mismatch = (message: string, mismatches: string[]): void => {
  mismatches.push(message);
};

export const checkDialect = ({
  engine,
  sentBoundedOutputField,
  separation,
  anatomy,
}: {
  engine: string | null;
  sentBoundedOutputField: "max_completion_tokens" | "max_tokens";
  separation: ReasoningSeparationResolution;
  anatomy: ResponseAnatomy | null;
}): DiagnosticDialectCheck => {
  const expected = expectationFor(engine);
  const observed: ReasoningSource | null = anatomy?.reasoning_source ?? null;
  const base: DiagnosticDialectCheck = {
    engine,
    expected_reasoning_source: expected?.reasoning_source ?? null,
    expected_bounded_output_field: expected?.bounded_output_field ?? sentBoundedOutputField,
    observed_reasoning_source: observed,
    reasoning_source_matched: null,
    bounded_output_field_matched: null,
    mismatches: [],
  };

  const mismatches: string[] = [];
  const boundedMatch = expected
    ? expected.bounded_output_field === sentBoundedOutputField
    : null;
  if (boundedMatch === false) {
    mismatch(
      `${engine} is documented to take ${expected?.bounded_output_field} but the probe sent ${sentBoundedOutputField}`,
      mismatches,
    );
  }

  const claimsSeparation = expected !== null && separation.state !== "UNSUPPORTED";

  if (expected && claimsSeparation && observed !== null) {
    if (observed === "inline") {
      mismatch(
        `${engine} is documented to report reasoning in ${expected.reasoning_source} but the reasoning arrived inside content`,
        mismatches,
      );
    } else if (
      expected.reasoning_source !== null &&
      observed !== expected.reasoning_source
    ) {
      mismatch(
        `${engine} is documented to report reasoning in ${expected.reasoning_source} but the runtime used ${observed}`,
        mismatches,
      );
    }
  }

  if (
    expected?.reports_reasoning_tokens === false &&
    anatomy !== null &&
    anatomy.reasoning_tokens === null
  ) {
    mismatch(
      `${engine} reports no reasoning token count, so reasoning_tokens is null rather than zero and reasoning_length is authoritative`,
      mismatches,
    );
  }

  const reasoningSourceMatched =
    expected && claimsSeparation && observed !== null
      ? observed === expected.reasoning_source
      : null;

  return {
    ...base,
    reasoning_source_matched: reasoningSourceMatched,
    bounded_output_field_matched: boundedMatch,
    mismatches,
  };
};

export const dialectEvidence = (dialect: DiagnosticDialectCheck): readonly string[] =>
  dialect.mismatches;