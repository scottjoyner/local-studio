import { describe, expect, it } from "bun:test";

import type {
  CompatibilityReport,
  RuntimeBackendInfo,
} from "../../src/modules/models/types";
import { buildCompatibilityReport } from "../../src/modules/system/platform/compatibility-report";

const backend = (installed: boolean): RuntimeBackendInfo => ({
  installed,
  version: null,
  python_path: null,
  binary_path: null,
  upgrade_command_available: true,
});

type BackendName = "vllm" | "sglang" | "llamacpp" | "mlx";

const reportWith = (
  installedBackends: BackendName[],
  hip: string | null,
): CompatibilityReport =>
  buildCompatibilityReport({
    runtime: {
      platform: {
        kind: "rocm",
        torch: {
          torch_version: hip ? "2.9.0" : null,
          torch_cuda: null,
          torch_hip: hip,
        },
      },
      gpu_monitoring: { available: true, tool: "amd-smi" },
      cuda: {},
      gpus: { count: 1 },
      backends: {
        vllm: backend(installedBackends.includes("vllm")),
        sglang: backend(installedBackends.includes("sglang")),
        llamacpp: backend(installedBackends.includes("llamacpp")),
        mlx: backend(installedBackends.includes("mlx")),
      },
    } as never,
    inference_port: 8010,
    inference_port_open: true,
    inference_process_known: true,
    gpu_monitoring: { available: true, tool: "amd-smi" },
  });

const severityOf = (
  report: CompatibilityReport,
  id: string,
): string | undefined =>
  report.checks.find((entry) => entry.id === id)?.severity;

const hasError = (report: CompatibilityReport): boolean =>
  report.checks.some((entry) => entry.severity === "error");

describe("buildCompatibilityReport torch scoping", () => {
  it("does not fail the report when no torch-based backend is installed", () => {
    const report = reportWith([], null);

    expect(severityOf(report, "torch.rocm-missing-hip")).toBe("info");
    expect(hasError(report)).toBe(false);
  });

  it("still errors when vLLM is installed without a HIP build", () => {
    const report = reportWith(["vllm"], null);

    expect(severityOf(report, "torch.rocm-missing-hip")).toBe("error");
    expect(hasError(report)).toBe(true);
  });

  it("still errors when SGLang is installed without a HIP build", () => {
    const report = reportWith(["sglang"], null);

    expect(severityOf(report, "torch.rocm-missing-hip")).toBe("error");
  });

  it("does not raise the check at all when HIP is present", () => {
    const report = reportWith([], "6.3.0");

    expect(severityOf(report, "torch.rocm-missing-hip")).toBeUndefined();
  });

  it("leaves non-torch backends out of the condition", () => {
    // llama.cpp does not require PyTorch, so installing it must not re-escalate.
    const report = reportWith(["llamacpp"], null);

    expect(severityOf(report, "torch.rocm-missing-hip")).toBe("info");
    expect(hasError(report)).toBe(false);
  });
});