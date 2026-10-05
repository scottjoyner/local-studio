import type { Config } from "../../config/env";
import type { GpuInfo } from "../models/types";
import { resolveRecipeGpuUuids } from "../system/gpu-visibility";
import type { Recipe } from "../models/types";
import { recipeToLaunchInput } from "./bridge";
import type { HostProfile, LaunchPlan } from "./contracts";
import type { RecipeLaunchPreview } from "../../../contracts/recipes";
import { applyDevices } from "./engines/devices";
import { engineSpec, planLaunch } from "./engines/registry";

/**
 * A read-only prediction of what a recipe would launch as.
 *
 * This exists because the recipe editor used to render its command preview from a second,
 * hand-written model of every engine's flags. That model drifted: it omitted
 * `--reasoning-format` and `--metrics` for llama.cpp, `--parallel` for llama.cpp, and
 * `--max-tokens`/`--trust-remote-code` for mlx. A user configuring a reasoning model was shown
 * a command with no reasoning configuration at all while launch applied `--reasoning-format
 * deepseek`. Rendering from the same `planLaunch` the launcher uses makes that class of drift
 * impossible rather than merely detectable.
 *
 * Pure by construction — GPU discovery is the caller's job — so it is directly testable against
 * the launch path.
 */

/**
 * Mirrors the input construction in `lifecycle.ts`, including the custom-command branch: when
 * a recipe carries `launch_command` the author owns the argv verbatim and only device selection
 * is folded in. The editor deliberately excludes overrides from its generated preview and shows
 * them separately, which is why this branch exists rather than being an error.
 */
export const previewRecipeLaunch = (
  recipe: Recipe,
  config: Config,
  host: HostProfile,
  gpus: readonly GpuInfo[],
): RecipeLaunchPreview => {
  const spec = engineSpec(recipe.backend);
  const resolution = resolveRecipeGpuUuids(recipe, gpus);
  const input = recipeToLaunchInput(recipe, config, resolution.uuids);
  const warnings: string[] = [];

  if (resolution.unresolvedTokens.length > 0) {
    warnings.push(
      `GPU selectors could not be resolved: ${resolution.unresolvedTokens.join(", ")}`,
    );
  }

  // The launcher takes the port and devices from its reservation record. A preview has no
  // reservation, so it uses the recipe's own port falling back to configured default — the
  // same value the launcher starts from before any dynamic reallocation.
  const port = recipe.port || config.inference_port;
  if (input.runtime === "docker") {
    warnings.push("Container model paths are resolved at mount time and may differ on the host.");
  }

  const plan: LaunchPlan = input.commandOverride
    ? applyDevices(
        {
          kind: input.runtime,
          argv: [...input.commandOverride],
          env: input.env,
          ports: [{ container: port, host: port }],
          mounts: [],
          devices: resolution.uuids,
          health: spec.health,
          ...(input.dockerImage ? { image: input.dockerImage } : {}),
        },
        host.accelerator,
      )
    : planLaunch({
        engine: input.engine,
        host,
        runtime: input.runtime,
        devices: resolution.uuids,
        port,
        modelPath: input.modelPath,
        servedModelName: input.servedModelName,
        options: input.options,
        extraArgs: input.extraArgs,
        env: input.env,
        dockerImage: input.dockerImage,
        binary: input.binary ?? spec.defaultBinary,
      });

  if (!input.commandOverride && recipe.port === 0) {
    warnings.push("Port is allocated at launch; the preview shows the configured default.");
  }

  return {
    // `input.engine` is typed EngineId only because bridge.ts widens with a cast; for a recipe
    // the engine is the backend, so read it from the recipe and keep the narrower type.
    engine: recipe.backend,
    kind: plan.kind,
    argv: [...plan.argv],
    binary: input.binary ?? spec.defaultBinary,
    port,
    devices: [...resolution.uuids],
    docker_image: input.dockerImage,
    warnings,
  };
};
