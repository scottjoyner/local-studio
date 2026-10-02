const normalizedArch = (value) => String(value ?? "").trim().toLowerCase();

export const normalizePciDeviceId = (value) => {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[|\]/g, "")
    .replace(/0x/g, "");
  return /^[0-9a-f]{4}:[0-9a-f]{4}$/.test(cleaned) ? cleaned : null;
};

export const extractPciDevices = (text) => {
  const devices = [];
  for (const line of String(text ?? "").split("\n")) {
    const seen = new Set();
    for (const match of line.matchAll(/\[([0-9a-f]{4}):([0-9a-f]{4})\]/gi)) {
      const id = `${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      devices.push({ id, line: line.trim() });
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

  const requiredName = String(requiredGpuName ?? "").trim().toLowerCase();
  const matchingGpuName =
    requiredName.length > 0
      ? (controllerGpus ?? []).find(
          (gpu) =>
            gpu &&
            typeof gpu === "object" &&
            typeof gpu.name === "string" &&
            gpu.name.toLowerCase().includes(requiredName),
        ) ?? null
      : null;

  const normalizedRequiredPciDeviceId = normalizePciDeviceId(requiredPciDeviceId);
  const matchingPciDevice =
    normalizedRequiredPciDeviceId === null
      ? null
      : (pciDevices ?? []).find(
          (device) => normalizePciDeviceId(device?.id) === normalizedRequiredPciDeviceId,
        ) ?? null;

  const memoryFloorMb = Number(requiredMemoryMb);
  const validMemoryFloor =
    Number.isInteger(memoryFloorMb) && memoryFloorMb > 0 ? memoryFloorMb : null;
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

  const hardwareIdentityMethod = matchingGpuName
    ? "controller-name"
    : matchingPciDevice && matchingMemoryGpu
      ? "pci-device+memory"
      : null;
  const hardwareIdentityAccepted = hardwareIdentityMethod !== null;

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
  };
};
