import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import type { Config } from "../../../config/env";
import { resolveBinary, runCommandAsyncEffect } from "../../../core/command";
import { LLAMACPP_HELP_TIMEOUT_MS } from "../configs";
import type { ProcessInfo } from "../../models/types";
import type { RuntimeBackendInfo, RuntimeUpgradeResult } from "@local-studio/contracts/system";
import { getLlamacppRuntimeInfo } from "../runtimes/runtime-info";
import type { ConfigHelpResult, EngineSpec, InstallOptions } from "../engine-spec";
import {
  getUpgradeCommandFromEnvironment,
  LLAMACPP_UPGRADE_ENV,
  runEnvironmentUpgradeCommand,
} from "../runtimes/upgrade-config";
import { installManagedLlamacpp } from "../runtimes/managed-llamacpp";
import { resolveLlamaBinary } from "../../compute/llamacpp-binary";

export { resolveLlamaBinary };

const getRuntimeInfo = (
  config: Config,
  _runningProcess?: Pick<ProcessInfo, "pid" | "backend"> | null,
): Effect.Effect<RuntimeBackendInfo> => getLlamacppRuntimeInfo(config);

const getConfigHelp = (config: Config): Effect.Effect<ConfigHelpResult> => {
  const configured = config.llama_bin || "llama-server";
  const resolved =
    resolveBinary(configured) ?? (existsSync(configured) ? resolve(configured) : null);
  const binary = resolved ?? configured;
  return runCommandAsyncEffect(binary, ["--help"], { timeoutMs: LLAMACPP_HELP_TIMEOUT_MS }).pipe(
    Effect.map((result) =>
      result.status !== 0
        ? {
            config: result.stdout || null,
            error: result.stderr || "Failed to fetch llama.cpp config",
          }
        : { config: result.stdout || null, error: null },
    ),
  );
};

const installLlamacpp = (options: InstallOptions): Effect.Effect<RuntimeUpgradeResult> => {
  const command = getUpgradeCommandFromEnvironment(LLAMACPP_UPGRADE_ENV);
  if (command) {
    return runEnvironmentUpgradeCommand(command, options.onSpawn);
  }
  return installManagedLlamacpp(options);
};

const managedPackageSpec = (_version?: string | null): string => "llama.cpp";

export const llamacppSpec: EngineSpec = {
  id: "llamacpp",
  healthPath: "/health",
  cliBinary: "llama-server",
  managedPackageSpec,
  install: installLlamacpp,
  getRuntimeInfo,
  getConfigHelp,
};
