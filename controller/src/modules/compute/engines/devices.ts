import type { Accelerator, DeviceId, LaunchPlan } from "../contracts";

/**
 * The single place device selection becomes a mechanism.
 *
 * Engines declare `plan.devices` abstractly; this translates that list into whatever the
 * accelerator and runtime actually need. Before this existed the same derivation lived in
 * four modules with four different key precedences (gpu-leases, process-utilities,
 * process-manager, backend-builder) — one of which resolved UUIDs against an empty GPU
 * list and so only ever saw the raw selector.
 */

/** Docker flags a launcher must add for this plan. Empty for process launches. */
export interface DeviceRuntimeFlags {
  readonly args: readonly string[];
  readonly groupAdd: readonly string[];
}

const joined = (devices: readonly DeviceId[]): string => devices.join(",");

const VENDOR_NAMESPACE = /^(?:nvidia|amd|apple|intel|unknown):/;

/**
 * Selectors as the runtime tooling wants them, without the controller's namespace.
 *
 * Two separate mistakes meet in this one function, and each was made on its own elsewhere:
 * slicing at the *last* colon turns a PCI bus id (`c7:00.0`) into `00.0` and truncates a
 * UUID to a hex fragment, while never stripping the `cuda:`/`amd:` prefix at all leaves the
 * runtime holding a namespaced token it cannot resolve.
 *
 * So strip a leading vendor namespace only, and leave everything after it alone. An id with
 * no namespace is already a bare PCI id or UUID and passes through untouched.
 */
const runtimeSelectors = (devices: readonly DeviceId[]): string =>
  devices.map((device) => device.replace(VENDOR_NAMESPACE, "")).join(",");

export const deviceEnvironment = (
  accelerator: Accelerator,
  devices: readonly DeviceId[],
): Readonly<Record<string, string>> => {
  if (devices.length === 0) return {};
  switch (accelerator) {
    case "cuda":
      // DeviceIds are namespaced `cuda:<UUID>`; CUDA accepts the UUID, not the prefix.
      return { CUDA_VISIBLE_DEVICES: runtimeSelectors(devices) };
    case "rocm":
      // ROCR_ gates the runtime, HIP_ gates the HIP API; setting only one leaves the
      // other seeing every card on the box.
      return {
        HIP_VISIBLE_DEVICES: runtimeSelectors(devices),
        ROCR_VISIBLE_DEVICES: runtimeSelectors(devices),
      };
    case "xpu":
      return { ONEAPI_DEVICE_SELECTOR: `level_zero:${runtimeSelectors(devices)}` };
    case "metal":
    case "cpu":
      // Metal exposes no device selection, and CPU has nothing to select.
      return {};
  }
};

export const dockerFlagsFor = (
  accelerator: Accelerator,
  devices: readonly DeviceId[],
): DeviceRuntimeFlags => {
  if (devices.length === 0) return { args: [], groupAdd: [] };
  switch (accelerator) {
    case "cuda":
      return { args: ["--gpus", `"device=${joined(devices)}"`], groupAdd: [] };
    case "rocm":
      return {
        args: ["--device", "/dev/kfd", "--device", "/dev/dri", "--security-opt", "seccomp=unconfined"],
        groupAdd: ["video", "render"],
      };
    case "xpu":
      return { args: ["--device", "/dev/dri"], groupAdd: ["render"] };
    case "metal":
    case "cpu":
      return { args: [], groupAdd: [] };
  }
};

/**
 * Fold device selection into a plan's environment. Runtime is taken from the plan: a
 * docker plan still gets the env vars (the container reads them) *plus* the flags the
 * launcher applies separately via `dockerFlagsFor`.
 */
export const applyDevices = (plan: LaunchPlan, accelerator: Accelerator): LaunchPlan => ({
  ...plan,
  env: { ...plan.env, ...deviceEnvironment(accelerator, plan.devices) },
});
