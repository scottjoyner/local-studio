import { expect, test } from "bun:test";
import {
  observeReasoningBudget,
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
import { profileBoundsProblem } from "../../src/modules/diagnostics/runtime-identity";

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

test("vLLM reports its real per-request reasoning budget", () => {
  const resolution = resolveReasoningBudget({ engine: "vllm", requested: 256, maxOutputTokens: 512 });
  expect(resolution.state).toBe("SUPPORTED");
  expect(resolution.mechanism).toBe("request_field");
  expect(resolution.request_field).toBe("thinking_token_budget");
  expect(resolution.engine_flag).toBeNull();
  expect(resolution.applies_to_request).toBe(true);
});

test("SGLang and MLX report the budget as unsupported rather than faking it", () => {
  for (const engine of ["sglang", "mlx"]) {
    const resolution = resolveReasoningBudget({ engine, requested: 256, maxOutputTokens: 512 });
    expect(resolution.state).toBe("UNSUPPORTED");
    expect(resolution.mechanism).toBe("none");
    expect(resolution.engine_flag).toBeNull();
    expect(resolution.request_field).toBeNull();
  }
});

test("a budget is judged only on a measurement that actually exists", () => {
  const supported = resolveReasoningBudget({ engine: "vllm", requested: 256, maxOutputTokens: 512 });
  expect(
    observeReasoningBudget(supported, {
      sent: true,
      reasoningTokens: 900,
    }).state,
  ).toBe("IGNORED_BY_ENGINE");
  expect(
    observeReasoningBudget(supported, { sent: true, reasoningTokens: 256 })
      .state,
  ).toBe("SUPPORTED");
  expect(
    observeReasoningBudget(supported, { sent: true, reasoningTokens: 120 })
      .state,
  ).toBe("SUPPORTED");
  expect(
    observeReasoningBudget(supported, { sent: true, reasoningTokens: null })
      .state,
  ).toBe("UNOBSERVED");
});

test("a budget that was never sent is not judged either way", () => {
  const supported = resolveReasoningBudget({ engine: "vllm", requested: 256, maxOutputTokens: 512 });
  expect(
    observeReasoningBudget(supported, { sent: false, reasoningTokens: 900 })
      .state,
  ).toBe("SUPPORTED");
});

test("an unobservable budget is never reported as honored or ignored", () => {
  const unsupported = resolveReasoningBudget({
    engine: "llamacpp",
    requested: 256,
    maxOutputTokens: 512,
  });
  expect(
    observeReasoningBudget(unsupported, {
      sent: true,
      reasoningTokens: 900
    }).state,
  ).toBe("SUPPORTED");
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
  const observed = observeReasoningSeparation(separation, { kind: "inline" });
  expect(observed.state).toBe("IGNORED_BY_ENGINE");
  expect(observed.engine_flag).toBe("--reasoning-format");
});

test("an unsupported directive is never upgraded to IGNORED_BY_ENGINE", () => {
  const separation = reasoningSeparationFor("mlx");
  expect(observeReasoningSeparation(separation, { kind: "inline" }).state).toBe("UNSUPPORTED");
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
    expect(profileBoundsProblem(profile)).toBeNull();
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

test("a vLLM request carries thinking_token_budget when the profile budgets reasoning", () => {
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  const resolution = resolveReasoningBudget({
    engine: "vllm",
    requested: profile.reasoning_budget_tokens,
    maxOutputTokens: profile.max_output_tokens,
  });
  const { body, reasoning_budget_sent } = buildDiagnosticRequestBody({
    profile,
    model: "candidate",
    engine: "vllm",
    reasoningBudget: resolution,
  });
  expect(reasoning_budget_sent).toBe(true);
  expect(body["thinking_token_budget"]).toBe(256);
  expect(body["max_completion_tokens"]).toBe(256);
});

test("a llama.cpp request carries no reasoning budget because the flag is launch-time only", () => {
  const profile = diagnosticProfile("short_reasoning");
  if (!profile) throw new Error("short_reasoning profile is missing");
  const resolution = resolveReasoningBudget({
    engine: "llamacpp",
    requested: profile.reasoning_budget_tokens,
    maxOutputTokens: profile.max_output_tokens,
  });
  const { body, reasoning_budget_sent } = buildDiagnosticRequestBody({
    profile,
    model: "candidate",
    engine: "llamacpp",
    reasoningBudget: resolution,
  });
  expect(reasoning_budget_sent).toBe(false);
  expect(body["thinking_token_budget"]).toBeUndefined();
  expect(Object.keys(body).some((key) => key.includes("budget"))).toBe(false);
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
test("a malformed profile is rejected by a pure check rather than a throw", () => {
  const base = diagnosticProfile("protocol_canary");
  if (!base) throw new Error("protocol_canary profile is missing");
  expect(profileBoundsProblem({ ...base, first_token_timeout_ms: 99_999 })).toContain(
    "first token",
  );
  expect(profileBoundsProblem({ ...base, max_output_tokens: 0 })).toContain("max_output_tokens");
  expect(profileBoundsProblem({ ...base, reasoning_budget_tokens: 9_999 })).toContain(
    "no room for a final answer",
  );
  expect(profileBoundsProblem({ ...base, reasoning_budget_tokens: -1 })).toContain(
    "not a non-negative integer",
  );
  expect(profileBoundsProblem(base)).toBeNull();
});

test("the profile catalog is frozen so one probe cannot change the next", () => {
  const profile = diagnosticProfile("protocol_canary");
  if (!profile) throw new Error("protocol_canary profile is missing");
  expect(Object.isFrozen(profile)).toBe(true);
  expect(Object.isFrozen(profile.stop)).toBe(true);
  expect(Object.isFrozen(allDiagnosticProfiles())).toBe(true);
  expect(() => {
    (profile as { max_output_tokens: number }).max_output_tokens = 999_999;
  }).toThrow();
  expect(diagnosticProfile("protocol_canary")?.max_output_tokens).toBe(16);
});

test("a stop sequence reaches the request body when a profile declares one", () => {
  const base = diagnosticProfile("protocol_canary");
  if (!base) throw new Error("protocol_canary profile is missing");
  const withStop = { ...base, stop: ["\n\n"] };
  const { body } = buildDiagnosticRequestBody({
    profile: withStop,
    model: "candidate",
    engine: "llamacpp",
  });
  expect(body["stop"]).toEqual(["\n\n"]);
});

test("a profile without a stop sequence sends no stop field", () => {
  const base = diagnosticProfile("protocol_canary");
  if (!base) throw new Error("protocol_canary profile is missing");
  const { body } = buildDiagnosticRequestBody({
    profile: base,
    model: "candidate",
    engine: "llamacpp",
  });
  expect(body["stop"]).toBeUndefined();
});

test("separation is judged even when the profile asked for no reasoning budget", () => {
  const separation = reasoningSeparationFor("llamacpp");
  expect(observeReasoningSeparation(separation, { kind: "inline" }).state).toBe(
    "IGNORED_BY_ENGINE",
  );
  expect(observeReasoningSeparation(separation, { kind: "separated" }).state).toBe("SUPPORTED");
});
