import { describe, expect, test } from "bun:test";
import { deviceEnvironment } from "../../src/modules/compute/engines/devices";

/** What the runtime tooling actually receives. */
const cuda = (ids: string[]): string =>
  deviceEnvironment("cuda", ids as never)["CUDA_VISIBLE_DEVICES"] ?? "";
const hip = (ids: string[]): string =>
  deviceEnvironment("rocm", ids as never)["HIP_VISIBLE_DEVICES"] ?? "";

describe("device selectors handed to runtime tooling", () => {
  test("a namespaced ordinal becomes a bare ordinal", () => {
    expect(cuda(["amd:0"])).toBe("0");
    expect(hip(["amd:0"])).toBe("0");
    expect(hip(["amd:1"])).toBe("1");
  });

  test("the vendor namespace is stripped so CUDA sees a resolvable UUID", () => {
    const uuid = "GPU-3a2f1c0b-9d4e-4f6a-8b7c-1d2e3f4a5b6c";
    expect(cuda([`nvidia:${uuid}`])).toBe(uuid);
    expect(hip([`amd:28181ed839b31975`])).toBe("28181ed839b31975");
  });

  test("a bare PCI bus id keeps every segment", () => {
    // Slicing at the last colon yields "00.0", which selects nothing.
    expect(hip(["c7:00.0"])).toBe("c7:00.0");
  });

  test("a bare UUID is passed through whole", () => {
    const uuid = "GPU-3a2f1c0b-9d4e-4f6a-8b7c-1d2e3f4a5b6c";
    expect(cuda([uuid])).toBe(uuid);
  });

  test("several devices stay comma separated", () => {
    expect(hip(["amd:0", "amd:1"])).toBe("0,1");
    expect(cuda(["nvidia:GPU-aaaa", "nvidia:GPU-bbbb"])).toBe("GPU-aaaa,GPU-bbbb");
  });

  test("no devices yields no environment at all", () => {
    expect(deviceEnvironment("cuda", [] as never)).toEqual({});
  });
});
