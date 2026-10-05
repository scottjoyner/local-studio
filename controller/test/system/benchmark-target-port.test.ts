import { describe, expect, it } from "bun:test";

import { resolveInferenceTargetPort } from "../../src/http/local-fetch";

/**
 * `/benchmark` resolves the model from the observed process but used to send the
 * request to `config.inference_port`. A recipe may pin any port -- the R9700/Bonsai
 * recipe pins 8010 -- so the two differ in exactly the configuration the promotion
 * lane runs, and the request went to whatever else owned the configured port
 * (assistx on 8000), returning 404 and `benchmarkEvidenceAccepted: false`.
 */
describe("resolveInferenceTargetPort", () => {
  it("prefers the observed process port over the configured default", () => {
    expect(resolveInferenceTargetPort(8010, 8000)).toBe(8010);
  });

  it("falls back to the configured port when no port is observed", () => {
    expect(resolveInferenceTargetPort(0, 8000)).toBe(8000);
  });

  it("never requests port 0", () => {
    expect(resolveInferenceTargetPort(0, 8000)).not.toBe(0);
  });

  it("uses the observed port when it matches the configured port", () => {
    expect(resolveInferenceTargetPort(8000, 8000)).toBe(8000);
  });
});