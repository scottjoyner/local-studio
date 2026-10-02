import { statSync } from "node:fs";
import type { DeviceId } from "../contracts";

/**
 * Headroom over the weight size for the compute graph and alignment padding.
 */
const WEIGHT_HEADROOM = 1.2;

/**
 * KV cache per requested context token. Measured on this box: a 6.5 GB ternary model at a
 * 32k f16 context occupied 9.6 GB, leaving 3.1 GB of KV and buffers, i.e. ~92 KB/token.
 * 128 KB keeps a modest margin over that without inflating a short-context request enough
 * to starve an instance that would genuinely fit alongside it.
 */
const KV_BYTES_PER_TOKEN = 128 * 1024;

/** Context beyond this contributes no useful signal and would swamp the estimate. */
const MAX_CONTEXT_TOKENS = 131_072;

/**
 * What an instance is expected to occupy, used to decide whether a device that already
 * carries leases can take another model.
 *
 * This is an estimate, and it is treated as one: it is only consulted when the telemetry
 * snapshot also reported the device's capacity, and the runtime remains the authority. If
 * the weights cannot be measured the estimate is zero, which keeps the previous exclusive
 * behaviour rather than guessing.
 */
export const estimateVramBytes = (modelPath: string, maxContextLength: number): number => {
  let weights = 0;
  try {
    weights = statSync(modelPath).size;
  } catch {
    return 0;
  }
  const tokens = Math.min(Math.max(0, maxContextLength), MAX_CONTEXT_TOKENS);
  return Math.round(weights * WEIGHT_HEADROOM + tokens * KV_BYTES_PER_TOKEN);
};

export interface DeviceCapacity {
  /** The card's full VRAM. Compared against this instance's own committed leases. */
  readonly totalBytes: number;
  /** What the driver currently reports as free. This includes the headroom other
   *  processes left us, so it is the only figure that knows about an unrelated workload
   *  sharing the card — our own bookkeeping cannot see those. */
  readonly freeBytes: number;
}

/** Per-device totals and free space, keyed by id, for the reservation's capacity check. */
export const capacityByDevice = (
  accelerators: readonly {
    readonly id: DeviceId;
    readonly memoryTotalBytes: number;
    readonly memoryUsedBytes: number;
  }[],
): Record<DeviceId, DeviceCapacity> => {
  const capacity: Record<DeviceId, DeviceCapacity> = {};
  for (const accelerator of accelerators) {
    capacity[accelerator.id] = {
      totalBytes: accelerator.memoryTotalBytes,
      freeBytes: Math.max(0, accelerator.memoryTotalBytes - accelerator.memoryUsedBytes),
    };
  }
  return capacity;
};

