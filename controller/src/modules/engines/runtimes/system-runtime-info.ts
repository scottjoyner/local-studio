import { arch, platform as operatingSystem } from "node:os";
import { Effect, Fiber, Semaphore } from "effect";
import type { ProcessInfo, RuntimePlatformInfo, SystemRuntimeInfo } from "../../models/types";
import type { Config } from "../../../config/env";
import { getGpuInfo, queryNvidiaSmiSnapshot } from "../../system/platform/gpu";
import { getVllmRuntimeInfo } from "./vllm-runtime";
import { probeGpuMonitoring } from "../../system/platform/compatibility-report";
import { getRocmInfo, resolveRocmSmiTool } from "../../system/platform/rocm-info";
import { resolveNvidiaSmiBinary } from "../../system/platform/smi-tools";
import { getTorchBuildInfo } from "../../system/platform/torch-info";
import { getEngineSpec, type EngineOperationError } from "../engine-spec";
import { detectPlatformKind, getCudaInfo } from "./runtime-info";

/**
 * The aggregate runtime snapshot for every backend on this host.
 *
 * This lives apart from `runtime-info.ts` on purpose. It is the only thing in that area that
 * needs the engine registry, and the registry imports the specs, while `llamacpp-spec` imports
 * `getLlamacppRuntimeInfo` from `runtime-info`. Keeping the aggregate here rather than there
 * breaks the `engine-spec -> specs -> runtime-info -> engine-spec` cycle, which otherwise
 * throws `ReferenceError: Cannot access 'llamacppSpec' before initialization` whenever a module
 * graph happens to evaluate the specs before the registry. That made it impossible to import the
 * recipe planner and the frontend command builder into one process, so the two could not be
 * compared directly in a test.
 *
 * The cache, its in-flight fiber and its semaphore live here too, because `shutdownRuntimeInfo`
 * has to reset the same state this populates.
 */

const SYSTEM_RUNTIME_CACHE_TTL_MS = 30_000;
let systemRuntimeCache: { expiresAt: number; value: SystemRuntimeInfo } | null = null;
let systemRuntimeInFlight: Fiber.Fiber<SystemRuntimeInfo, EngineOperationError> | null = null;
const systemRuntimeSemaphore = Semaphore.makeUnsafe(1);

export const getSystemRuntimeInfo = (
  config: Config,
  runningProcess?: ProcessInfo | null,
): Effect.Effect<SystemRuntimeInfo, EngineOperationError> =>
  Effect.gen(function* () {
    const fiber = yield* systemRuntimeSemaphore.withPermit(
      Effect.gen(function* () {
        const now = Date.now();
        if (systemRuntimeCache && systemRuntimeCache.expiresAt > now) {
          return yield* Effect.forkChild(Effect.succeed(systemRuntimeCache.value));
        }
        if (systemRuntimeInFlight) return systemRuntimeInFlight;
        const running = yield* computeSystemRuntimeInfo(config, runningProcess).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              systemRuntimeCache = {
                expiresAt: Date.now() + SYSTEM_RUNTIME_CACHE_TTL_MS,
                value,
              };
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              systemRuntimeInFlight = null;
            }),
          ),
          Effect.forkDetach({ startImmediately: true }),
        );
        systemRuntimeInFlight = running;
        return running;
      }),
    );
    return yield* Fiber.join(fiber);
  });

export const shutdownRuntimeInfo = (): Effect.Effect<void> =>
  Effect.suspend(() => {
    const fiber = systemRuntimeInFlight;
    systemRuntimeInFlight = null;
    systemRuntimeCache = null;
    return fiber ? Fiber.interrupt(fiber).pipe(Effect.asVoid) : Effect.void;
  });

const computeSystemRuntimeInfo = (
  config: Config,
  runningProcess?: ProcessInfo | null,
): Effect.Effect<SystemRuntimeInfo, EngineOperationError> =>
  Effect.gen(function* () {
    const forcedSmiTool = process.env["LOCAL_STUDIO_GPU_SMI_TOOL"];
    const hasNvidiaSmi = Boolean(resolveNvidiaSmiBinary());
    const rocmSmiTool = resolveRocmSmiTool();
    const hasRocmSmi = Boolean(rocmSmiTool);
    const nvidiaAllowed = !forcedSmiTool?.trim() || forcedSmiTool.trim() === "nvidia-smi";

    const vllmFiber = yield* Effect.forkChild(getVllmRuntimeInfo());
    const [nvidiaSnapshot, vllmInfo, sglangInfo, llamaInfo, mlxInfo, torch, detectedGpus] =
      yield* Effect.all(
        [
          nvidiaAllowed && hasNvidiaSmi ? queryNvidiaSmiSnapshot() : Effect.succeed(null),
          Fiber.join(vllmFiber),
          getEngineSpec("sglang").getRuntimeInfo!(config, runningProcess),
          getEngineSpec("llamacpp").getRuntimeInfo!(config, runningProcess),
          getEngineSpec("mlx").getRuntimeInfo!(config, runningProcess),
          Fiber.join(vllmFiber).pipe(
            Effect.flatMap((vllmInfo) =>
              getTorchBuildInfo(config.sglang_python || vllmInfo.python_path || "python3"),
            ),
          ),
          getGpuInfo(),
        ] as const,
        { concurrency: "unbounded" },
      );
    const gpus =
      nvidiaSnapshot && nvidiaSnapshot.gpus.length > 0 ? nvidiaSnapshot.gpus : detectedGpus;
    const types = Array.from(
      new Set(gpus.map((gpu) => gpu.name).filter((name) => name && name !== "Unknown")),
    );
    const kind = detectPlatformKind({
      forcedSmiTool,
      torch,
      hasNvidiaSmi,
      hasRocmSmi,
      isAppleSilicon: operatingSystem() === "darwin" && arch() === "arm64",
    });
    const rocm = kind === "rocm" ? yield* getRocmInfo(rocmSmiTool) : null;
    const platform: RuntimePlatformInfo = {
      kind,
      vendor:
        kind === "cuda" ? "nvidia" : kind === "rocm" ? "amd" : kind === "metal" ? "apple" : null,
      rocm,
      torch,
    };
    const [gpuMonitoring, cuda] = yield* Effect.all(
      [
        kind === "metal"
          ? Effect.succeed({ available: false, tool: "apple-metal" as const })
          : kind === "cuda" && nvidiaSnapshot
          ? Effect.succeed({ available: nvidiaSnapshot.available, tool: "nvidia-smi" as const })
          : probeGpuMonitoring(kind, rocmSmiTool),
        kind === "cuda"
          ? getCudaInfo(nvidiaSnapshot?.driverVersion ?? null)
          : Effect.succeed({
              driver_version: null,
              cuda_version: null,
              upgrade_command_available: false,
            }),
      ] as const,
      { concurrency: "unbounded" },
    );
    return {
      platform,
      gpu_monitoring: gpuMonitoring,
      cuda,
      gpus: { count: gpus.length, types },
      backends: {
        vllm: {
          installed: vllmInfo.installed,
          version: vllmInfo.version,
          python_path: vllmInfo.python_path,
          binary_path: vllmInfo.vllm_bin,
          upgrade_command_available: Boolean(vllmInfo.python_path),
        },
        sglang: sglangInfo,
        llamacpp: llamaInfo,
        mlx: mlxInfo,
      },
    };
  });
