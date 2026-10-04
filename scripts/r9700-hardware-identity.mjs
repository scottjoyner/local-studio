const normalizedArch = (value) => String(value ?? "").trim().toLowerCase();

export const normalizePciDeviceId = (value) => {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[|\]/g, "")
    .replace(/0x/g, "");
  if (/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(cleaned)) return cleaned;
  // Also accept a PCI bus address, dropping the optional PCI domain so that both
  // "0000:c7:00.0" and "c7:00.0" resolve to the same device.
  const bus = cleaned.match(/^(?:[0-9a-f]{4}:)?([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])$/);
  return bus ? bus[1] : null;
};

export const extractPciDevices = (text) => {
  const devices = [];
  for (const line of String(text ?? "").split("\n")) {
    const seen = new Set();
    const slotMatch = line.trim().match(/^([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])/i);
    const slot = slotMatch ? normalizePciDeviceId(slotMatch[1]) : null;
    for (const match of line.matchAll(/\[([0-9a-f]{4}):([0-9a-f]{4})\]/gi)) {
      const id = `${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      devices.push({ id, slot, line: line.trim() });
    }
  }
  return devices;
};

export const evaluateR9700HardwareIdentity = ({
  architectures,
  requiredArch,
  requiredGpuName,
  requiredPciDeviceId,
  requiredMemoryMb,
  controllerGpus,
  pciDevices,
}) => {
  const normalizedRequiredArch = normalizedArch(requiredArch);
  const architectureSet = new Set((architectures ?? []).map(normalizedArch));
  const hardwareArchitectureAccepted = architectureSet.has(normalizedRequiredArch);

  const memoryFloorMb = Number(requiredMemoryMb);
  const validMemoryFloor =
    Number.isInteger(memoryFloorMb) && memoryFloorMb > 0 ? memoryFloorMb : null;

  const requiredName = String(requiredGpuName ?? "").trim().toLowerCase();
  const matchingGpuName =
    requiredName.length > 0 && validMemoryFloor !== null
      ? (controllerGpus ?? []).find(
          (gpu) =>
            gpu &&
            typeof gpu === "object" &&
            typeof gpu.name === "string" &&
            gpu.name.toLowerCase().includes(requiredName) &&
            Number.isFinite(Number(gpu.memory_total_mb)) &&
            Number(gpu.memory_total_mb) >= validMemoryFloor,
        ) ?? null
      : null;

  const normalizedRequiredPciDeviceId = normalizePciDeviceId(requiredPciDeviceId);
  const matchingPciDevice =
    normalizedRequiredPciDeviceId === null
      ? null
      : (pciDevices ?? []).find(
          (device) =>
            [device?.id, device?.slot].some(
              (key) =>
                key &&
                normalizePciDeviceId(key) === normalizedRequiredPciDeviceId,
            ),
        ) ?? null;

  const matchingMemoryGpu =
    validMemoryFloor === null
      ? null
      : (controllerGpus ?? []).find(
          (gpu) =>
            gpu &&
            typeof gpu === "object" &&
            Number.isFinite(Number(gpu.memory_total_mb)) &&
            Number(gpu.memory_total_mb) >= validMemoryFloor,
        ) ?? null;

  // A supplied PCI id that resolves to nothing is a hard failure: silently
  // falling back to name+memory would claim a device identity never verified.
  // Reject only when PCI data is actually available and the required id is absent
  // from it. An empty pciDevices list means lspci is unavailable on this host, and
  // the controller-name+memory fallback is still legitimate there.
  const pciDeviceRejected =
    normalizedRequiredPciDeviceId !== null &&
    matchingPciDevice === null &&
    (pciDevices ?? []).length > 0;

  const pciDataAvailable = (pciDevices ?? []).length > 0;
  const enforcePci =
    normalizedRequiredPciDeviceId !== null && pciDataAvailable;

  const hardwareIdentityMethod = enforcePci
    ? matchingPciDevice && matchingMemoryGpu
      ? "pci-device+memory"
      : null
    : matchingGpuName
      ? "controller-name+memory"
      : matchingPciDevice && matchingMemoryGpu
        ? "pci-device+memory"
        : null;
  const hardwareIdentityAccepted =
    hardwareIdentityMethod !== null && !pciDeviceRejected;
  const pciIdentityEnforced = enforcePci;

  return {
    hardwareAccepted: hardwareArchitectureAccepted && hardwareIdentityAccepted,
    hardwareArchitectureAccepted,
    hardwareIdentityAccepted,
    hardwareIdentityMethod,
    matchingGpuName,
    matchingPciDevice,
    matchingMemoryGpu,
    normalizedRequiredPciDeviceId,
    requiredMemoryMb: validMemoryFloor,
    pciDeviceRejected,
    pciIdentityEnforced,
  };
};
