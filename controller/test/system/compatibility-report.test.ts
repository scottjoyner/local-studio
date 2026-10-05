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

/** Minimal ROCm host: no GPUs enumerated, no torch, no backends installed. */
type RocmeOnlyRuntime = {
  platform: { kind: "rocm"; torch: { torch_version: null; torch_cuda: null; torch_hip: null } };
  gpu_monitoring: { available: boolean; tool: string };
  cuda: Record<string, never>;
  gpus: { count: number };
  backends: Record<string, RuntimeBackendInfo>;
};

const rocmeOnlyRuntime = (): RocmeOnlyRuntime => ({
  platform: {
    kind: "rocm" as const,
    torch: { torch_version: null, torch_cuda: null, torch_hip: null },
  },
  gpu_monitoring: { available: true, tool: "amd-smi" as const },
  cuda: {},
  gpus: { count: 1 },
  backends: {
    vllm: backend(false),
    sglang: backend(false),
    llamacpp: backend(false),
    mlx: backend(false),
  },
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

  it("does not treat a squatted configured port as an error", () => {
    // Regression: a permanently occupied LOCAL_STUDIO_INFERENCE_PORT (assistx owns
    // 8000 on the R9700 host) made /compat permanently unsatisfiable, and the
    // promotion gate treats any error-severity check as disqualifying.
    const squatted = buildCompatibilityReport({
      runtime: rocmeOnlyRuntime() as never,
      inference_port: 8000,
      inference_port_open: true,
      inference_process_known: false,
      gpu_monitoring: { available: true, tool: "amd-smi" },
    });

    expect(severityOf(squatted, "inference.port-in-use")).toBe("warn");
    expect(hasError(squatted)).toBe(false);
  });

  it("still reports the squatted port when a process is known", () => {
    const known = buildCompatibilityReport({
      runtime: rocmeOnlyRuntime() as never,
      inference_port: 8000,
      inference_port_open: true,
      inference_process_known: true,
      inference_process_port: 8010,
      gpu_monitoring: { available: true, tool: "amd-smi" },
    });

    // A known process means this check must stay silent, and the observed port is
    // recorded so the mismatch with the configured port is visible.
    expect(severityOf(known, "inference.port-in-use")).toBeUndefined();
  });

  it("leaves non-torch backends out of the condition", () => {
    // llama.cpp does not require PyTorch, so installing it must not re-escalate.
    const report = reportWith(["llamacpp"], null);

    expect(severityOf(report, "torch.rocm-missing-hip")).toBe("info");
    expect(hasError(report)).toBe(false);
  });
});