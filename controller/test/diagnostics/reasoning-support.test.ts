import { expect, test } from "bun:test";
import {
  observeReasoningSeparation,
  reasoningSeparationFor,
  resolveReasoningBudget,
} from "../../src/modules/diagnostics/reasoning-support";
import {
  allDiagnosticProfiles,
  diagnosticProfile,
  isDiagnosticProfileName,
} from "../../src/modules/diagnostics/diagnostic-profiles";
import {
  boundedOutputField,
  buildDiagnosticRequestBody,
  groundedAnswerMatches,
} from "../../src/modules/diagnostics/diagnostic-request";
import { assertProfileBounds } from "../../src/modules/diagnostics/runtime-identity";

test("llama.cpp reports the launch-time budget flag it actually has", () => {
  const resolution = resolveReasoningBudget({
    engine: "llamacpp",
    requested: 256,
    maxOutputTokens: 256,
  });
  expect(resolution.state).toBe("SUPPORTED");
  expect(resolution.mechanism).toBe("server_flag");
  expect(resolution.engine_flag).toBe("--reasoning-budget");
  expect(resolution.applies_to_request).toBe(false);
});

test("vLLM and SGLang report the budget as unsupported rather than faking it", () => {
  for (const engine of ["vllm", "sglang", "mlx"]) {
    const resolution = resolveReasoningBudget({ engine, requested: 256, maxOutputTokens: 512 });
    expect(resolution.state).toBe("UNSUPPORTED");
    expect(resolution.mechanism).toBe("none");
    expect(resolution.engine_flag).toBeNull();
    expect(resolution.request_field).toBeNull();
  }
});

test("an undeclared engine is unsupported, not assumed capable", () => {
  expect(resolveReasoningBudget({ engine: null, requested: 128, maxOutputTokens: 512 }).state).toBe(
    "UNSUPPORTED",
  );
  expect(
    resolveReasoningBudget({ engine: "some-other-server", requested: 128, maxOutputTokens: 512 })
      .state,
  ).toBe("UNSUPPORTED");
});

test("an absent budget request stays null and does not invent a state change", () => {
  const resolution = resolveReasoningBudget({
    engine: "llamacpp",
    requested: null,
    maxOutputTokens: 256,
  });
  expect(resolution.requested).toBeNull();
  expect(resolution.state).toBe("SUPPORTED");
});

test("a budget larger than the output cap is an invalid configuration", () => {
  const resolution = resolveReasoningBudget({
    engine: "llamacpp",
    requested: 4_096,
    maxOutputTokens: 256,
  });
  expect(resolution.state).toBe("INVALID_CONFIGURATION");
  expect(resolution.detail).toContain("no room for a final answer");
});

test("a negative or fractional budget is an invalid configuration", () => {
  expect(
    resolveReasoningBudget({ engine: "llamacpp", requested: -1, maxOutputTokens: 256 }).state,
  ).toBe("INVALID_CONFIGURATION");
  expect(
    resolveReasoningBudget({ engine: "llamacpp", requested: 12.5, maxOutputTokens: 256 }).state,
  ).toBe("INVALID_CONFIGURATION");
});

test("separation is supported only where the engine actually splits reasoning out", () => {
  for (const engine of ["llamacpp", "vllm", "sglang"]) {
    const separation = reasoningSeparationFor(engine);
    expect(separation.state).toBe("SUPPORTED");
    expect(separation.engine_flag).not.toBeNull();
  }
  for (const engine of ["mlx", "exllamav3", null]) {
    expect(reasoningSeparationFor(engine).state).toBe("UNSUPPORTED");
  }
});

test("a runtime that answers without separating reasoning is IGNORED_BY_ENGINE", () => {
  const separation = reasoningSeparationFor("llamacpp");
  const observed = observeReasoningSeparation(separation, {
    requested: true,
    separated: false,
  });
  expect(observed.state).toBe("IGNORED_BY_ENGINE");
  expect(observed.engine_flag).toBe("--reasoning-format");
});

test("an unsupported directive is never upgraded to IGNORED_BY_ENGINE", () => {
  const separation = reasoningSeparationFor("mlx");
  expect(observeReasoningSeparation(separation, { requested: true, separated: false }).state).toBe(
    "UNSUPPORTED",
  );
});

test("every catalog profile is bounded, self-consistent, and node-agnostic", () => {
  const profiles = allDiagnosticProfiles();
  expect(profiles.map((profile) => profile.name)).toEqual([
    "protocol_canary",
    "exact_grounding",
    "short_reasoning",
    "bounded_code",
  ]);
  for (const profile of profiles) {
    assertProfileBounds(profile);
    expect(profile.max_output_tokens).toBeGreaterThan(0);
    expect(profile.max_input_tokens).toBeGreaterThan(profile.prompt.length);
    expect(profile.first_token_timeout_ms).toBeLessThan(profile.timeout_ms);
    expect(profile.prompt.toLowerCase()).not.toContain("optiplex");
    expect(profile.prompt.toLowerCase()).not.toContain("lenovo");
    expect(profile.prompt.toLowerCase()).not.toContain("destroyer");
  }
});

test("the short_reasoning profile budgets inside its own output cap", () => {
  const profile = diagnosticProfile("short_reasoning");
  expect(profile?.reasoning_budget_tokens).toBe(256);
  expect(profile?.max_output_tokens).toBe(256);
  expect(diagnosticProfile("short_reasoning")?.expected_answer).toBe("0.05");
  expect(isDiagnosticProfileName("nope")).toBe(false);
});

test("bounded output uses the field each engine reads", () => {
  expect(boundedOutputField("vllm").field).toBe("max_completion_tokens");
  expect(boundedOutputField("sglang").field).toBe("max_completion_tokens");
  expect(boundedOutputField("llamacpp").field).toBe("max_tokens");
  expect(boundedOutputField("mlx").field).toBe("max_tokens");
  expect(boundedOutputField(null).field).toBe("max_completion_tokens");
});

test("a built request carries the cap, the temperature, and streaming usage", () => {
  const profile = diagnosticProfile("protocol_canary");
  if (!profile) throw new Error("protocol_canary profile is missing");
  const { body } = buildDiagnosticRequestBody({
    profile,
    model: "candidate",
    engine: "vllm",
  });
  expect(body["max_completion_tokens"]).toBe(profile.max_output_tokens);
  expect(body["max_tokens"]).toBeUndefined();
  expect(body["temperature"]).toBe(0);
  expect(body["stream"]).toBe(true);
  expect(body["stream_options"]).toEqual({ include_usage: true });
  expect(body["model"]).toBe("candidate");
});

test("a llama.cpp request bounds with max_tokens instead", () => {
  const profile = diagnosticProfile("protocol_canary");
  if (!profile) throw new Error("protocol_canary profile is missing");
  const { body } = buildDiagnosticRequestBody({
    profile,
    model: "candidate",
    engine: "llamacpp",
  });
  expect(body["max_tokens"]).toBe(profile.max_output_tokens);
  expect(body["max_completion_tokens"]).toBeUndefined();
});

test("grounding is reported as evidence and never as a classification", () => {
  const exact = diagnosticProfile("exact_grounding");
  const code = diagnosticProfile("bounded_code");
  if (!exact || !code) throw new Error("diagnostic profiles are missing");
  expect(groundedAnswerMatches(exact, "the token is LST-QUAL-4417")).toBe(true);
  expect(groundedAnswerMatches(exact, "I cannot help with that")).toBe(false);
  expect(groundedAnswerMatches(code, "function add(a, b) {}")).toBeNull();
});