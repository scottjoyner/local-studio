#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const argv = process.argv.slice(2);

const values = (name) => {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] !== undefined) result.push(argv[index + 1]);
  }
  return result;
};

const value = (name, fallback = null) => values(name).at(-1) ?? fallback;
const has = (name) => argv.includes(name);

if (has("--help")) {
  process.stdout.write(
    [
      "Usage: node scripts/capture-local-ai-evidence.mjs [options]",
      "  --output <path>",
      "  --controller <local-studio-controller-url>",
      "  --endpoint <openai-base-url>",
      "  --model <served-model-id>",
      "  --recipe <recipe-id>",
      "  --model-revision <revision>",
      "  --model-file <path>",
      "  --projector-file <path>",
      "  --engine-ref <image-or-runtime-revision>",
      "  --engine-file <path>",
      "  --require-arch <gfx-arch>",
      "  --require-gpu-name <substring>",
      "  --api-key-env <environment-variable>",
      "  --request-timeout-ms <milliseconds>",
      "  --benchmark-timeout-ms <milliseconds>",
      "  --session <agent=path-or-session-id>  repeatable",
      "  --opencode",
      "  --opencode-session <session-id>        repeatable",
      "  --opencode-root <path>",
      "  --opencode-config <path>",
      "  --opencode-receipt <receipt.json>",
      "  --opencode-export <sanitized-export.json>",
      "  --hermes",
      "  --hermes-home <path>",
      "  --benchmark <path>                  repeatable",
      "  --run-benchmark",
      "  --benchmark-prompt-tokens <count>",
      "  --artifact <path>                   repeatable",
      "  --skip-completion",
      "  --probe-tools",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const expandPath = (input) => {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
};

const sha256File = async (path) => {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
};

const pathEvidence = async (kind, reference, agent = null) => {
  const path = expandPath(reference);
  if (!existsSync(path)) return { kind, agent, reference, present: null, type: "opaque" };
  const stat = statSync(path);
  if (!stat.isFile()) return { kind, agent, reference: path, present: true, type: "directory" };
  return {
    kind,
    agent,
    reference: path,
    present: true,
    type: "file",
    sizeBytes: stat.size,
    sha256: await sha256File(path),
  };
};

const fileMetadataEvidence = (kind, reference) => {
  const path = expandPath(reference);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  return {
    kind,
    reference: path,
    present: true,
    type: "file-metadata",
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
};

const verifyOpenCodeSessionEvidence = async ({
  receiptReference,
  exportReference,
  expectedModel,
  requestedSessionIds,
}) => {
  if (!receiptReference && !exportReference) return null;

  const receiptFile = receiptReference
    ? await pathEvidence("opencode-receipt", receiptReference, "opencode")
    : null;
  const exportFile = exportReference
    ? await pathEvidence("opencode-sanitized-export", exportReference, "opencode")
    : null;
  const failures = [];

  if (!receiptReference) failures.push("missing-receipt");
  if (!exportReference) failures.push("missing-sanitized-export");
  if (receiptFile?.type !== "file") failures.push("receipt-not-file-backed");
  if (exportFile?.type !== "file") failures.push("export-not-file-backed");

  let receipt = null;
  let exported = null;
  if (receiptFile?.type === "file") {
    try {
      receipt = JSON.parse(readFileSync(receiptFile.reference, "utf8"));
    } catch {
      failures.push("receipt-invalid-json");
    }
  }
  if (exportFile?.type === "file") {
    try {
      exported = JSON.parse(readFileSync(exportFile.reference, "utf8"));
    } catch {
      failures.push("export-invalid-json");
    }
  }

  if (receipt) {
    if (receipt.schemaVersion !== "local-studio/opencode-session-evidence/v1") {
      failures.push("receipt-schema-mismatch");
    }
    if (receipt.accepted !== true) failures.push("receipt-not-accepted");
    if (receipt.expected?.modelID !== expectedModel) failures.push("receipt-model-mismatch");
    if (
      typeof receipt.expected?.providerID !== "string" ||
      receipt.expected.providerID.length === 0
    ) {
      failures.push("receipt-provider-unpinned");
    }
    if (receipt.acceptanceTurn?.modelAccepted !== true) failures.push("receipt-model-not-accepted");
    if (receipt.acceptanceTurn?.providerAccepted !== true) failures.push("receipt-provider-not-accepted");
    if (receipt.acceptanceTurn?.toolRoundTripAccepted !== true) failures.push("receipt-tool-not-accepted");
    if (receipt.acceptanceTurn?.fallbackDetected !== false) failures.push("receipt-fallback-detected");
    if (
      !Array.isArray(receipt.acceptanceTurn?.assistantErrors) ||
      receipt.acceptanceTurn.assistantErrors.length !== 0
    ) {
      failures.push("receipt-assistant-errors");
    }
    if (
      requestedSessionIds.length > 0 &&
      !requestedSessionIds.includes(receipt.sessionId)
    ) {
      failures.push("receipt-session-id-mismatch");
    }
  }

  if (receipt && exportFile?.type === "file") {
    if (receipt.sanitizedExport?.sha256 !== exportFile.sha256) {
      failures.push("export-sha256-mismatch");
    }
    if (Number(receipt.sanitizedExport?.sizeBytes) !== Number(exportFile.sizeBytes)) {
      failures.push("export-size-mismatch");
    }
  }

  if (receipt && exported) {
    if (exported?.info?.id !== receipt.sessionId) failures.push("export-session-id-mismatch");
    if (!Array.isArray(exported?.messages)) {
      failures.push("export-messages-missing");
    } else {
      let lastUserIndex = -1;
      for (let index = 0; index < exported.messages.length; index += 1) {
        if (exported.messages[index]?.info?.role === "user") lastUserIndex = index;
      }
      if (lastUserIndex < 0) {
        failures.push("export-user-turn-missing");
      } else {
        const assistants = exported.messages
          .slice(lastUserIndex + 1)
          .filter((message) => message?.info?.role === "assistant");
        if (assistants.length === 0) failures.push("export-assistant-turn-missing");

        const providerID = receipt.expected?.providerID;
        if (
          assistants.some(
            (message) =>
              message?.info?.modelID !== expectedModel ||
              message?.info?.providerID !== providerID,
          )
        ) {
          failures.push("export-provider-model-fallback");
        }
        if (assistants.some((message) => message?.info?.error)) {
          failures.push("export-assistant-error");
        }

        const completedTools = assistants.flatMap((message) =>
          (Array.isArray(message.parts) ? message.parts : [])
            .filter((part) => part?.type === "tool" && part?.state?.status === "completed")
            .map((part) => part.tool)
            .filter((tool) => typeof tool === "string"),
        );
        const minCompletedTools = Number(receipt.expected?.minCompletedTools ?? 1);
        if (
          !Number.isInteger(minCompletedTools) ||
          minCompletedTools < 1 ||
          completedTools.length < minCompletedTools
        ) {
          failures.push("export-tool-round-trip-missing");
        }
        const requiredTools = Array.isArray(receipt.expected?.requiredTools)
          ? receipt.expected.requiredTools
          : [];
        if (requiredTools.some((tool) => !completedTools.includes(tool))) {
          failures.push("export-required-tool-missing");
        }
      }
    }
  }

  return {
    accepted: failures.length === 0,
    failures,
    receiptFile,
    exportFile,
    receipt: receipt
      ? {
          schemaVersion: receipt.schemaVersion ?? null,
          sessionId: receipt.sessionId ?? null,
          expected: receipt.expected ?? null,
          acceptanceTurn: receipt.acceptanceTurn ?? null,
          accepted: receipt.accepted === true,
        }
      : null,
  };
};

const sessionEvidence = await Promise.all(
  values("--session").map(async (entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new Error(`Invalid --session value: ${entry}; expected agent=reference`);
    }
    return pathEvidence("session", entry.slice(separator + 1), entry.slice(0, separator));
  }),
);

const opencodeRoot = expandPath(value("--opencode-root", "~/.local/share/opencode"));
const opencodeConfigOverride = value("--opencode-config") ?? process.env["OPENCODE_CONFIG"] ?? null;
const opencodeConfig = opencodeConfigOverride
  ? expandPath(opencodeConfigOverride)
  : ["~/.config/opencode/opencode.jsonc", "~/.config/opencode/opencode.json", "~/.config/opencode/endpoints.json"]
      .map(expandPath)
      .find((candidate) => existsSync(candidate)) ?? null;
const opencodeSessionIds = values("--opencode-session");
const opencodeReceiptReference = value("--opencode-receipt");
const opencodeExportReference = value("--opencode-export");
const opencodeRequested =
  has("--opencode") ||
  opencodeSessionIds.length > 0 ||
  Boolean(opencodeReceiptReference) ||
  Boolean(opencodeExportReference);
const opencodeSessionEvidence = await Promise.all(
  opencodeSessionIds.map(async (sessionId) => {
    const candidates = [
      resolve(opencodeRoot, "storage", "session_diff", `${sessionId}.json`),
      resolve(opencodeRoot, "storage", "session_diff", sessionId),
      resolve(opencodeRoot, "storage", "session", `${sessionId}.json`),
      resolve(opencodeRoot, "sessions", `${sessionId}.json`),
    ];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (match) return pathEvidence("session", match, "opencode");
    return {
      kind: "session",
      agent: "opencode",
      reference: sessionId,
      present: null,
      type: "opaque",
    };
  }),
);
const allSessionEvidence = [...sessionEvidence, ...opencodeSessionEvidence];
const hermesRequested =
  has("--hermes") || allSessionEvidence.some((entry) => entry.agent === "hermes");
const hermesHome = expandPath(
  value("--hermes-home", process.env["HERMES_HOME"] ?? "~/.hermes"),
);

const benchmarkEvidence = await Promise.all(
  values("--benchmark").map((entry) => pathEvidence("benchmark", entry)),
);
const artifactEvidence = await Promise.all(
  values("--artifact").map((entry) => pathEvidence("artifact", entry)),
);
const modelFile = value("--model-file");
const projectorFile = value("--projector-file");
const engineFile = value("--engine-file");
const modelFileEvidence = modelFile ? await pathEvidence("model", modelFile) : null;
const projectorFileEvidence = projectorFile
  ? await pathEvidence("projector", projectorFile)
  : null;
const engineFileEvidence = engineFile ? await pathEvidence("engine", engineFile) : null;

const command = (binary, args) => {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const missing = result.error && result.error.code === "ENOENT";
  return {
    available: !missing,
    status: result.status,
    stdout: (result.stdout ?? "").trim().slice(0, 32768),
    stderr: (result.stderr ?? "").trim().slice(0, 8192),
  };
};

const rocminfo = command("rocminfo", []);
const architectures = Array.from(
  new Set((rocminfo.stdout.match(/\bgfx[0-9a-f]+\b/gi) ?? []).map((entry) => entry.toLowerCase())),
).sort();
const requiredArch = value("--require-arch", "gfx1201").toLowerCase();
const requiredGpuName = value("--require-gpu-name", "Radeon AI PRO R9700");
const sourceRevision = command("git", ["rev-parse", "HEAD"]);
const sourceStatus = command("git", ["status", "--porcelain", "--untracked-files=no"]);
const uname = command("uname", ["-a"]);
const amdSmi = command("amd-smi", ["static", "--json", "-g", "all"]);
const opencodeVersion = opencodeRequested ? command("opencode", ["--version"]) : null;
const opencodeStore = opencodeRequested
  ? fileMetadataEvidence("session-store", resolve(opencodeRoot, "opencode.db"))
  : null;
const hermesVersion = hermesRequested ? command("hermes", ["--version"]) : null;
const hermesStore = hermesRequested
  ? fileMetadataEvidence("session-store", resolve(hermesHome, "state.db"))
  : null;
const opencodeEndpointConfig =
  opencodeRequested && opencodeConfig
    ? await pathEvidence("endpoint-config", opencodeConfig, "opencode")
    : null;
const rocmSmi = command("rocm-smi", [
  "--showproductname",
  "--showmeminfo",
  "vram",
  "--showuse",
  "--showtemp",
  "--showpower",
]);

const controller = value("--controller");
const endpoint = value("--endpoint") ?? (controller ? `${controller.replace(/\/$/, "")}/v1` : null);
const model = value("--model");
const opencodeReceiptVerification = await verifyOpenCodeSessionEvidence({
  receiptReference: opencodeReceiptReference,
  exportReference: opencodeExportReference,
  expectedModel: model,
  requestedSessionIds: opencodeSessionIds,
});
const apiKeyEnv = value("--api-key-env", "LOCAL_STUDIO_API_KEY");
const apiKey = process.env[apiKeyEnv] ?? "";
const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
const positiveTimeout = (name, fallback) => {
  const parsed = Number(value(name, String(fallback)));
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 900000) {
    throw new Error(`${name} must be an integer from 1000 to 900000`);
  }
  return parsed;
};
const requestTimeoutMs = positiveTimeout("--request-timeout-ms", 60_000);
const benchmarkTimeoutMs = positiveTimeout("--benchmark-timeout-ms", 300_000);

const requestJson = async (url, init = {}, timeoutMs = requestTimeoutMs) => {
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, error: String(error) };
  }
};

let controllerEvidence = null;
let liveBenchmarkEvidence = null;
if (controller) {
  const base = controller.replace(/\/$/, "");
  controllerEvidence = {
    baseUrl: base,
    status: await requestJson(`${base}/status`),
    compatibility: await requestJson(`${base}/compat`),
    gpus: await requestJson(`${base}/gpus`),
    computeEngines: await requestJson(`${base}/compute/engines`),
  };
  if (has("--run-benchmark")) {
    const promptTokensRaw = value("--benchmark-prompt-tokens", "1000");
    const promptTokens = Number(promptTokensRaw);
    if (!Number.isInteger(promptTokens) || promptTokens < 1 || promptTokens > 100000) {
      throw new Error("--benchmark-prompt-tokens must be an integer from 1 to 100000");
    }
    const before = await requestJson(`${base}/v1/metrics/vllm`);
    const response = await requestJson(
      `${base}/benchmark?prompt_tokens=${encodeURIComponent(String(promptTokens))}`,
      { method: "POST" },
      benchmarkTimeoutMs,
    );
    const after = await requestJson(`${base}/v1/metrics/vllm`);
    const benchmark =
      response.body && typeof response.body === "object" ? response.body.benchmark : null;
    liveBenchmarkEvidence = {
      requestedPromptTokens: promptTokens,
      response,
      metricsBefore: before,
      metricsAfter: after,
      accepted:
        response.ok === true &&
        response.body &&
        typeof response.body === "object" &&
        response.body.success === true &&
        benchmark &&
        typeof benchmark === "object" &&
        Number(benchmark.prompt_tokens) > 0 &&
        Number(benchmark.completion_tokens) > 0 &&
        Number(benchmark.generation_tps) > 0,
    };
  }
}

let endpointEvidence = null;
if (endpoint) {
  const rawBase = endpoint.replace(/\/$/, "");
  const base = rawBase.endsWith("/v1") ? rawBase : `${rawBase}/v1`;
  const models = await requestJson(`${base}/models`);
  let completion = null;
  if (model && !has("--skip-completion")) {
    const response = await requestJson(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly LOCAL_AI_ACCEPTED" }],
        temperature: 0,
      }),
    });
    const content =
      response.body && typeof response.body === "object"
        ? response.body?.choices?.[0]?.message?.content
        : null;
    completion = {
      ...response,
      accepted: typeof content === "string" && content.includes("LOCAL_AI_ACCEPTED"),
    };
  }
  let toolCall = null;
  if (model && has("--probe-tools")) {
    const response = await requestJson(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content:
              "Call report_acceptance exactly once with token LOCAL_AI_TOOL_ACCEPTED. Do not answer normally.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "report_acceptance",
              description: "Report the deterministic local AI acceptance token.",
              parameters: {
                type: "object",
                properties: { token: { type: "string" } },
                required: ["token"],
                additionalProperties: false,
              },
            },
          },
        ],
        temperature: 0,
      }),
    });
    const calls =
      response.body && typeof response.body === "object"
        ? response.body?.choices?.[0]?.message?.tool_calls
        : null;
    const matchingCall = Array.isArray(calls)
      ? calls.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            entry.function &&
            typeof entry.function === "object" &&
            entry.function.name === "report_acceptance",
        ) ?? null
      : null;
    let toolArguments = null;
    const rawArguments = matchingCall?.function?.arguments;
    if (typeof rawArguments === "string") {
      try {
        toolArguments = JSON.parse(rawArguments);
      } catch {
        toolArguments = null;
      }
    } else if (rawArguments && typeof rawArguments === "object") {
      toolArguments = rawArguments;
    }
    toolCall = {
      ...response,
      accepted:
        response.ok === true &&
        matchingCall !== null &&
        toolArguments?.token === "LOCAL_AI_TOOL_ACCEPTED",
      matchedFunction: matchingCall?.function?.name ?? null,
      arguments: toolArguments,
    };
  }
  const advertisedModelIds =
    models.body &&
    typeof models.body === "object" &&
    Array.isArray(models.body.data)
      ? models.body.data
          .map((entry) => (entry && typeof entry === "object" ? entry.id : null))
          .filter((entry) => typeof entry === "string")
      : [];
  endpointEvidence = {
    baseUrl: base,
    models,
    advertisedModelIds,
    modelAdvertised: model ? advertisedModelIds.includes(model) : null,
    completion,
    toolCall,
  };
}

const manifest = {
  schemaVersion: "local-studio/local-ai-evidence/v1",
  capturedAt: new Date().toISOString(),
  source: {
    localStudioRevision:
      sourceRevision.status === 0 && sourceRevision.stdout ? sourceRevision.stdout : null,
    trackedCheckoutStatus: sourceStatus,
    uname: uname.status === 0 ? uname.stdout : null,
  },
  target: {
    recipeId: value("--recipe"),
    model,
    modelRevision: value("--model-revision"),
    modelFile: modelFileEvidence,
    projectorFile: projectorFileEvidence,
    engineRef: value("--engine-ref"),
    engineFile: engineFileEvidence,
  },
  hardware: {
    requiredArch,
    requiredGpuName,
    architectures,
    requiredArchPresent: architectures.includes(requiredArch),
    rocminfo,
    amdSmi,
    rocmSmi,
  },
  controller: controllerEvidence,
  endpoint: endpointEvidence,
  clients: {
    opencode: opencodeRequested
      ? {
          version: opencodeVersion,
          root: opencodeRoot,
          store: opencodeStore,
          endpointConfig: opencodeEndpointConfig,
          requestedSessionIds: opencodeSessionIds,
          sessionEvidence: opencodeReceiptVerification,
        }
      : null,
    hermes: hermesRequested
      ? {
          version: hermesVersion,
          home: hermesHome,
          store: hermesStore,
        }
      : null,
  },
  sessions: allSessionEvidence,
  benchmarks: benchmarkEvidence,
  liveBenchmark: liveBenchmarkEvidence,
  artifacts: artifactEvidence,
  summary: (() => {
    const hardwareArchitectureAccepted = architectures.includes(requiredArch);
    const controllerGpus =
      controllerEvidence?.gpus?.body &&
      typeof controllerEvidence.gpus.body === "object" &&
      Array.isArray(controllerEvidence.gpus.body.gpus)
        ? controllerEvidence.gpus.body.gpus
        : [];
    const matchingGpu =
      typeof requiredGpuName === "string" && requiredGpuName.trim()
        ? controllerGpus.find(
            (gpu) =>
              gpu &&
              typeof gpu === "object" &&
              typeof gpu.name === "string" &&
              gpu.name.toLowerCase().includes(requiredGpuName.trim().toLowerCase()),
          ) ?? null
        : null;
    const hardwareIdentityAccepted = Boolean(matchingGpu);
    const hardwareAccepted = hardwareArchitectureAccepted && hardwareIdentityAccepted;
    const controllerAccepted = controllerEvidence?.status?.ok ?? null;
    const compatibilityAccepted =
      controllerEvidence?.compatibility?.ok === true &&
      Array.isArray(controllerEvidence?.compatibility?.body?.checks)
        ? !controllerEvidence.compatibility.body.checks.some(
            (check) => check && typeof check === "object" && check.severity === "error",
          )
        : controllerEvidence?.compatibility?.ok ?? null;
    const endpointModelsAccepted = endpointEvidence?.models?.ok ?? null;
    const modelAdvertised = endpointEvidence?.modelAdvertised ?? null;
    const completionAccepted = endpointEvidence?.completion?.accepted ?? null;
    const toolProbeRequested = has("--probe-tools");
    const toolCallAccepted = endpointEvidence?.toolCall?.accepted ?? null;
    const modelArtifactAccepted = Boolean(modelFileEvidence?.sha256);
    const projectorArtifactAccepted = projectorFile
      ? Boolean(projectorFileEvidence?.sha256)
      : null;
    const engineArtifactAccepted = Boolean(engineFileEvidence?.sha256);
    const acceptedSessionAgents = new Set(["opencode", "hermes"]);
    const fileBackedSessionEvidenceByAgent = Object.fromEntries(
      Array.from(acceptedSessionAgents, (agent) => [
        agent,
        allSessionEvidence.filter(
          (entry) =>
            entry.agent === agent &&
            entry.type === "file" &&
            typeof entry.sha256 === "string",
        ).length,
      ]),
    );
    const fileBackedSessionEvidenceCount = Object.values(
      fileBackedSessionEvidenceByAgent,
    ).reduce((sum, count) => sum + count, 0);
    const opencodeSessionEvidenceAccepted = opencodeReceiptVerification?.accepted === true;
    const hermesSessionEvidenceAccepted =
      fileBackedSessionEvidenceByAgent.hermes > 0;
    const hashedBenchmarkEvidenceCount = benchmarkEvidence.filter(
      (entry) => entry.type === "file" && typeof entry.sha256 === "string",
    ).length;
    const sessionEvidenceAccepted =
      opencodeSessionEvidenceAccepted || hermesSessionEvidenceAccepted;
    const localStudioRevision =
      sourceRevision.status === 0 && /^[0-9a-f]{40}$/i.test(sourceRevision.stdout)
        ? sourceRevision.stdout.toLowerCase()
        : null;
    const sourceCheckoutAccepted =
      localStudioRevision !== null && sourceStatus.status === 0 && sourceStatus.stdout === "";
    const liveBenchmarkAccepted = liveBenchmarkEvidence?.accepted ?? null;
    const benchmarkEvidenceAccepted =
      hashedBenchmarkEvidenceCount > 0 || liveBenchmarkAccepted === true;
    const artifactProvenanceAccepted =
      modelArtifactAccepted &&
      engineArtifactAccepted &&
      (projectorFile ? projectorArtifactAccepted === true : true);
    const candidatePromotable =
      hardwareAccepted &&
      controllerAccepted === true &&
      compatibilityAccepted === true &&
      endpointModelsAccepted === true &&
      modelAdvertised === true &&
      completionAccepted === true &&
      toolProbeRequested === true &&
      toolCallAccepted === true &&
      sourceCheckoutAccepted === true &&
      artifactProvenanceAccepted &&
      sessionEvidenceAccepted &&
      benchmarkEvidenceAccepted;
    return {
      hardwareAccepted,
      hardwareArchitectureAccepted,
      hardwareIdentityAccepted,
      requiredGpuName,
      matchingGpu,
      controllerAccepted,
      compatibilityAccepted,
      endpointModelsAccepted,
      modelAdvertised,
      completionAccepted,
      toolProbeRequested,
      toolCallAccepted,
      localStudioRevision,
      sourceCheckoutAccepted,
      modelArtifactAccepted,
      projectorArtifactAccepted,
      engineArtifactAccepted,
      artifactProvenanceAccepted,
      sessionEvidenceAccepted,
      opencodeSessionEvidenceAccepted,
      hermesSessionEvidenceAccepted,
      benchmarkEvidenceAccepted,
      liveBenchmarkAccepted,
      candidatePromotable,
      sessionEvidenceCount: allSessionEvidence.length,
      fileBackedSessionEvidenceCount,
      fileBackedSessionEvidenceByAgent,
      benchmarkEvidenceCount: benchmarkEvidence.length,
      hashedBenchmarkEvidenceCount,
      artifactEvidenceCount: artifactEvidence.length,
    };
  })(),
};

const output = expandPath(value("--output", "local-ai-evidence.json"));
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
