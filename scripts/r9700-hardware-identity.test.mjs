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
assert.equal(explicitNameAccepted.hardwareIdentityMethod, "controller-name+memory");

const namedButUndersizedRejected = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "Radeon AI PRO R9700",
  requiredPciDeviceId: "1002:7551",
  requiredMemoryMb: 30000,
  controllerGpus: [
    { index: 0, name: "AMD Radeon AI PRO R9700", memory_total_mb: 16384 },
  ],
  pciDevices: [],
});
assert.equal(namedButUndersizedRejected.hardwareIdentityAccepted, false);

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

// A required PCI id that is absent from available PCI data must not silently fall
// back to a name+memory match, which would assert an identity never verified.
const absentPciRejected = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "Radeon AI PRO R9700",
  requiredPciDeviceId: "1234:5678",
  requiredMemoryMb: 30000,
  controllerGpus: [{ index: 0, name: "AMD Radeon Graphics", memory_total_mb: 32624 }],
  pciDevices: [{ id: "1002:7551", line: "[1002:7551]" }],
});
assert.equal(absentPciRejected.pciDeviceRejected, true);
assert.equal(absentPciRejected.pciIdentityEnforced, true);
assert.equal(absentPciRejected.hardwareAccepted, false);

// With PCI data present, a required id that does resolve must use the PCI method.
const presentPciEnforced = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "AMD Radeon Graphics",
  requiredPciDeviceId: "1002:7551",
  requiredMemoryMb: 30000,
  controllerGpus: [{ index: 0, name: "AMD Radeon Graphics", memory_total_mb: 32624 }],
  pciDevices: [{ id: "1002:7551", line: "[1002:7551]" }],
});
assert.equal(presentPciEnforced.pciIdentityEnforced, true);
assert.equal(presentPciEnforced.pciDeviceRejected, false);
assert.equal(presentPciEnforced.hardwareIdentityMethod, "pci-device+memory");
assert.equal(presentPciEnforced.hardwareAccepted, true);

// A bus address is a real, parseable contract. When PCI data is available but
// carries no matching slot, it must be rejected rather than treated as "not
// supplied" and downgraded to a name+memory match.
const slotAbsentFromPciData = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "AMD Radeon Graphics",
  requiredPciDeviceId: "c7:00.0",
  requiredMemoryMb: 30000,
  controllerGpus: [{ index: 0, name: "AMD Radeon Graphics", memory_total_mb: 32624 }],
  pciDevices: [{ id: "1002:7551", line: "[1002:7551]" }],
});
assert.equal(slotAbsentFromPciData.pciIdentityEnforced, true);
assert.equal(slotAbsentFromPciData.pciDeviceRejected, true);
assert.equal(slotAbsentFromPciData.hardwareAccepted, false);

// PCI bus addresses are a documented contract, so they must resolve just like a
// vendor:device pair, with and without the PCI domain.
assert.equal(normalizePciDeviceId("0000:c7:00.0"), "c7:00.0");
assert.equal(normalizePciDeviceId("c7:00.0"), "c7:00.0");
assert.equal(normalizePciDeviceId("C7:00.0"), "c7:00.0");
assert.equal(normalizePciDeviceId("zz:00.0"), null);

const slotDevices = extractPciDevices(
  "0000:c7:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Device [1002:7551]",
);
assert.equal(slotDevices[0].id, "1002:7551");
assert.equal(slotDevices[0].slot, "c7:00.0");

for (const requiredPciDeviceId of ["0000:c7:00.0", "c7:00.0", "1002:7551"]) {
  const bySlot = evaluateR9700HardwareIdentity({
    architectures: ["gfx1201"],
    requiredArch: "gfx1201",
    requiredGpuName: "AMD Radeon Graphics",
    requiredPciDeviceId,
    requiredMemoryMb: 30000,
    controllerGpus: [{ index: 0, name: "AMD Radeon Graphics", memory_total_mb: 32624 }],
    pciDevices: slotDevices,
  });
  assert.equal(bySlot.pciIdentityEnforced, true);
  assert.equal(bySlot.pciDeviceRejected, false);
  assert.equal(bySlot.hardwareIdentityMethod, "pci-device+memory");
  assert.equal(bySlot.hardwareAccepted, true);
}

// A bus address that is absent from available PCI data must be rejected, not
// quietly downgraded to a name+memory match.
const absentSlotRejected = evaluateR9700HardwareIdentity({
  architectures: ["gfx1201"],
  requiredArch: "gfx1201",
  requiredGpuName: "AMD Radeon Graphics",
  requiredPciDeviceId: "ff:00.0",
  requiredMemoryMb: 30000,
  controllerGpus: [{ index: 0, name: "AMD Radeon Graphics", memory_total_mb: 32624 }],
  pciDevices: slotDevices,
});
assert.equal(absentSlotRejected.pciDeviceRejected, true);
assert.equal(absentSlotRejected.hardwareAccepted, false);
