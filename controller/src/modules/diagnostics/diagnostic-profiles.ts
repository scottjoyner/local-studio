import type {
  DiagnosticProfile,
  DiagnosticProfileName,
} from "@local-studio/contracts/inference-diagnostics";

const profiles: Readonly<Record<DiagnosticProfileName, DiagnosticProfile>> = {
  protocol_canary: {
    name: "protocol_canary",
    purpose: "Cheapest proof the endpoint speaks the OpenAI chat dialect and returns a well-formed choice.",
    max_input_tokens: 256,
    max_output_tokens: 16,
    temperature: 0,
    top_p: 1,
    reasoning_budget_tokens: null,
    timeout_ms: 20_000,
    first_token_timeout_ms: 10_000,
    stream: true,
    stop: [],
    expect_grounded_answer: true,
    prompt: "Reply with exactly: OK",
    expected_answer: "OK",
  },
  exact_grounding: {
    name: "exact_grounding",
    purpose: "Copy a literal token verbatim, which fails when the runtime emits monologue instead of the answer.",
    max_input_tokens: 256,
    max_output_tokens: 32,
    temperature: 0,
    top_p: 1,
    reasoning_budget_tokens: null,
    timeout_ms: 45_000,
    first_token_timeout_ms: 20_000,
    stream: true,
    stop: [],
    expect_grounded_answer: true,
    prompt: "Copy the following token exactly, with no other text: LST-QUAL-4417",
    expected_answer: "LST-QUAL-4417",
  },
  short_reasoning: {
    name: "short_reasoning",
    purpose: "Force a short derivation then a short answer, which exposes reasoning that consumes the whole budget.",
    max_input_tokens: 512,
    max_output_tokens: 256,
    temperature: 0,
    top_p: 1,
    reasoning_budget_tokens: 256,
    timeout_ms: 95_000,
    first_token_timeout_ms: 30_000,
    stream: true,
    stop: [],
    expect_grounded_answer: true,
    prompt:
      "A bat and a ball cost 1.10 together. The bat costs 1.00 more than the ball. How much does the ball cost? Reply with the number only.",
    expected_answer: "0.05",
  },
  bounded_code: {
    name: "bounded_code",
    purpose: "Emit a small fenced-free code block to confirm bounded output stops cleanly instead of truncating.",
    max_input_tokens: 512,
    max_output_tokens: 256,
    temperature: 0,
    top_p: 1,
    reasoning_budget_tokens: null,
    timeout_ms: 60_000,
    first_token_timeout_ms: 25_000,
    stream: true,
    stop: [],
    expect_grounded_answer: false,
    prompt:
      "Write a JavaScript function named add that returns the sum of its two arguments. Reply with code only, no explanation.",
    expected_answer: null,
  },
};

/**
 * The catalog is handed to callers who build request bodies from it, so it is
 * frozen rather than merely typed `readonly`: a probe that mutated a profile in
 * place would silently change every later probe.
 */
const frozenProfiles: Readonly<Record<DiagnosticProfileName, DiagnosticProfile>> =
  Object.freeze(
    Object.fromEntries(
      (Object.entries(profiles) as [DiagnosticProfileName, DiagnosticProfile][]).map(
        ([name, profile]) => [name, Object.freeze({ ...profile, stop: Object.freeze([...profile.stop]) })],
      ),
    ) as Record<DiagnosticProfileName, DiagnosticProfile>,
  );

export const diagnosticProfile = (name: string): DiagnosticProfile | null =>
  Object.hasOwn(frozenProfiles, name) ? frozenProfiles[name as DiagnosticProfileName] : null;

const frozenList: readonly DiagnosticProfile[] = Object.freeze(
  Object.values(frozenProfiles),
);

export const allDiagnosticProfiles = (): readonly DiagnosticProfile[] => frozenList;

export const isDiagnosticProfileName = (name: string): name is DiagnosticProfileName =>
  Object.hasOwn(profiles, name);