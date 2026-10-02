#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  evaluateR9700HardwareIdentity,
  extractPciDevices,
  normalizePciDeviceId,
} from "./r9700-hardware-identity.mjs";

assert.equal(normalizePciDeviceId("1002:7551"), "1002:7551");
assert.equal(normalizePciDeviceId("[1002:7551]"), "1002:7551");
assert.equal(normalizePciDeviceId("0x1002:0x7551"), "1002:7551");
assert.equal(normalizePciDeviceId("7551"), null);

const pciDevices = extractPciDevices(
  "0000:c7:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Device [1002:7551] (rev c0)\n" +
    "0000:c9:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Device [1002:150e]\n",
);
assert.equal(pciDevices.some((entry) => entry.id === "1002:7551"), true);

const genericAccepted = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201", "gfx1150"],
  requiredArch: "gfx1201",
  requiredGpuName: "Radeon AI PRO R9700",
  requiredPciDeviceId: "1002:7551",
  requiredMemoryMb: 30000,
  controllerGpus: [
    {
      index: 0,
      name: "AMD Radeon Graphics",
      memory_total_mb: 32624,
    },
    {
      index: 1,
      name: "AMD Radeon 890M Graphics",
      memory_total_mb: 2048,
    },
  ],
  pciDevices,
});
assert.equal(genericAccepted.hardwareAccepted, true);
assert.equal(genericAccepted.hardwareIdentityAccepted, true);
assert.equal(genericAccepted.hardwareIdentityMethod, "pci-device+memory");
assert.equal(genericAccepted.matchingPciDevice?.id, "1002:7551");
assert.equal(genericAccepted.matchingMemoryGpu?.memory_total_mb, 32624);

const wrongPciRejected = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "Radeon AI PRO R9700",
  requiredPciDeviceId: "1002:7551",
  requiredMemoryMb: 30000,
  controllerGpus: [{ index: 0, name: "AMD Radeon Graphics", memory_total_mb: 32624 }],
  pciDevices: [{ id: "1002:9999", line: "[1002:9999]" }],
});
assert.equal(wrongPciRejected.hardwareIdentityAccepted, false);
assert.equal(wrongPciRejected.hardwareAccepted, false);

const undersizedRejected = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "Radeon AI PRO R9700",
  requiredPciDeviceId: "1002:7551",
  requiredMemoryMb: 30000,
  controllerGpus: [{ index: 0, name: "AMD Radeon Graphics", memory_total_mb: 16384 }],
  pciDevices: [{ id: "1002:7551", line: "[1002:7551]" }],
});
assert.equal(undersizedRejected.hardwareIdentityAccepted, false);

const explicitNameAccepted = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "Radeon AI PRO R9700",
  requiredPciDeviceId: "1002:7551",
  requiredMemoryMb: 30000,
  controllerGpus: [
    { index: 0, name: "AMD Radeon AI PRO R9700", memory_total_mb: 32624 },
  ],
  pciDevices: [],
});
assert.equal(explicitNameAccepted.hardwareAccepted, true);
assert.equal(explicitNameAccepted.hardwareIdentityMethod, "controller-name");

const wrongArchRejected = evaluateR9700HardwareIdentity({
  architectures: ["gfx1200"],
  requiredArch: "gfx1201",
  requiredGpuName: "Radeon AI PRO R9700",
  requiredPciDeviceId: "1002:7551",
  requiredMemoryMb: 30000,
  controllerGpus: [
    { index: 0, name: "AMD Radeon AI PRO R9700", memory_total_mb: 32624 },
  ],
  pciDevices: [],
});
assert.equal(wrongArchRejected.hardwareIdentityAccepted, true);
assert.equal(wrongArchRejected.hardwareAccepted, false);

process.stdout.write("R9700 hardware identity contract PASS\n");
