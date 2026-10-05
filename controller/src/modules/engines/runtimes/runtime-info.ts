import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import type {
  RuntimeBackendInfo,
  RuntimeCudaInfo,
  RuntimePlatformKind,
  RuntimeTorchBuildInfo,
} from "../../models/types";
import type { Config } from "../../../config/env";
import { resolveBinary, runCommandEffect, runCommandAsyncEffect } from "../../../core/command";
import { extractCudaVersion } from "./cuda-version";
import {
  isUpgradeCommandConfigured,
  CUDA_UPGRADE_ENV,
  LLAMACPP_UPGRADE_ENV,
} from "./upgrade-config";


export const detectPlatformKind = (args: {
  forcedSmiTool: string | undefined;
  torch: RuntimeTorchBuildInfo;
  hasNvidiaSmi: boolean;
  hasRocmSmi: boolean;
  isAppleSilicon?: boolean;
}): RuntimePlatformKind => {
  const forced = args.forcedSmiTool?.trim();
  if (forced === "nvidia-smi") return "cuda";
  if (forced === "amd-smi" || forced === "rocm-smi") return "rocm";
  if (args.torch.torch_hip) return "rocm";
  if (args.torch.torch_cuda) return "cuda";
  if (args.hasNvidiaSmi) return "cuda";
  if (args.hasRocmSmi) return "rocm";
  if (args.isAppleSilicon) return "metal";
  return "unknown";
};

const parseLlamaVersion = (output: string): string | null => {
  if (!output) return null;
  const match = output.match(/version\s*[:=]\s*(\d+\s*\([^)]+\)|\S+)/i);
  if (match) return match[1]?.trim() ?? null;
  const fallback = output.split("\n")[0]?.trim();
  return fallback || null;
};

export const getLlamacppRuntimeInfo = (config: Config): Effect.Effect<RuntimeBackendInfo> =>
  Effect.gen(function* () {
    const configured = config.llama_bin || "llama-server";
    const resolved =
      resolveBinary(configured) ?? (existsSync(configured) ? resolve(configured) : null);
    const binary = resolved ?? configured;
    const versionResult = yield* runCommandEffect(binary, ["--version"]);
    if (versionResult.status !== 0) {
      const helpResult = yield* runCommandEffect(binary, ["--help"]);
      if (helpResult.status !== 0) {
        return {
          installed: false,
          version: null,
          binary_path: resolved,
          upgrade_command_available: isUpgradeCommandConfigured(LLAMACPP_UPGRADE_ENV),
        };
      }
      const version = parseLlamaVersion(helpResult.stdout) ?? parseLlamaVersion(helpResult.stderr);
      return {
        installed: Boolean(version),
        version,
        binary_path: resolved,
        upgrade_command_available: isUpgradeCommandConfigured(LLAMACPP_UPGRADE_ENV),
      };
    }
    const version =
      parseLlamaVersion(versionResult.stdout) ?? parseLlamaVersion(versionResult.stderr);
    return {
      installed: Boolean(version),
      version,
      binary_path: resolved,
      upgrade_command_available: isUpgradeCommandConfigured(LLAMACPP_UPGRADE_ENV),
    };
  });

const extractNvccVersion = (output: string): string | null => {
  const match = output.match(/release\s+([0-9.]+)/i);
  if (match) return match[1] ?? null;
  return null;
};

export const getCudaInfo = (
  knownDriverVersion: string | null = null,
): Effect.Effect<RuntimeCudaInfo> =>
  Effect.gen(function* () {
    const nvidiaSmi = process.env["NVIDIA_SMI_PATH"] || "nvidia-smi";
    let driverVersion = knownDriverVersion;
    let cudaVersion: string | null = null;
    if (!driverVersion) {
      const driverResult = yield* runCommandAsyncEffect(
        nvidiaSmi,
        ["--query-gpu=driver_version", "--format=csv,noheader,nounits"],
        { timeoutMs: 5_000 },
      );
      if (driverResult.status === 0 && driverResult.stdout) {
        driverVersion = driverResult.stdout.split("\n")[0]?.trim() || null;
      }
    }
    const smiResult = yield* runCommandAsyncEffect(nvidiaSmi, [], { timeoutMs: 5_000 });
    if (smiResult.status === 0) {
      cudaVersion = extractCudaVersion(smiResult.stdout) ?? extractCudaVersion(smiResult.stderr);
    }
    if (!cudaVersion) {
      const nvccResult = yield* runCommandAsyncEffect("nvcc", ["--version"], { timeoutMs: 5_000 });
      if (nvccResult.status === 0) {
        cudaVersion =
          extractNvccVersion(nvccResult.stdout) ?? extractNvccVersion(nvccResult.stderr);
      }
    }
    return {
      driver_version: driverVersion,
      cuda_version: cudaVersion,
      upgrade_command_available: isUpgradeCommandConfigured(CUDA_UPGRADE_ENV),
    };
  });
