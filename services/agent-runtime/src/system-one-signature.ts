import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

export const SYSTEM_ONE_SIGNATURE_SCHEMA =
  "hermes-system-one-detached-signature-v1";
export const SYSTEM_ONE_SIGNATURE_DOMAIN =
  "hermes-system-one-uhp-response-bytes-ed25519-v1";

type JsonRecord = Record<string, unknown>;

type SignaturePolicy =
  | { mode: "legacy" }
  | {
      mode: "required";
      key: KeyObject;
      keyId: string;
      publicKeySha256: string;
    }
  | { mode: "invalid"; reason: string };

export type SystemOneSignatureVerification =
  | { outcome: "unsigned" }
  | {
      outcome: "verified";
      keyId: string;
      publicKeySha256: string;
      responseSha256: string;
      preimageSha256: string;
    }
  | { outcome: "rejected"; reason: string };

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function exactShape(value: JsonRecord, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return (
    expected.length === actual.length &&
    expected.every((key, index) => key === actual[index])
  );
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredBoolean(value: string | undefined): boolean | null {
  if (value == null || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function loadPolicy(): SignaturePolicy {
  const required = configuredBoolean(
    process.env.LOCAL_STUDIO_SYSTEM_ONE_REQUIRE_SIGNATURE,
  );
  if (required === null) {
    return { mode: "invalid", reason: "signature_policy_invalid" };
  }

  const keyPath =
    process.env.LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH?.trim() || "";
  if (!keyPath) {
    return required
      ? { mode: "invalid", reason: "signature_key_unconfigured" }
      : { mode: "legacy" };
  }

  try {
    const raw = readFileSync(keyPath);
    if (raw.length === 0 || raw.length > 16 * 1024) {
      return { mode: "invalid", reason: "signature_key_invalid" };
    }
    const key = createPublicKey(raw);
    if (key.asymmetricKeyType !== "ed25519") {
      return { mode: "invalid", reason: "signature_key_not_ed25519" };
    }
    const der = key.export({ type: "spki", format: "der" }) as Buffer;
    return {
      mode: "required",
      key,
      keyId: `ed25519:${sha256(der)}`,
      publicKeySha256: sha256(raw),
    };
  } catch {
    return { mode: "invalid", reason: "signature_key_invalid" };
  }
}

const SIGNATURE_POLICY = loadPolicy();

export function verifyConfiguredSystemOneSignature(
  responseRaw: string,
  signatureRaw: string | null,
): SystemOneSignatureVerification {
  if (SIGNATURE_POLICY.mode === "invalid") {
    return { outcome: "rejected", reason: SIGNATURE_POLICY.reason };
  }

  if (signatureRaw == null) {
    return SIGNATURE_POLICY.mode === "required"
      ? { outcome: "rejected", reason: "signature_required" }
      : { outcome: "unsigned" };
  }

  if (SIGNATURE_POLICY.mode !== "required") {
    return { outcome: "rejected", reason: "signature_key_unconfigured" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(signatureRaw);
  } catch {
    return { outcome: "rejected", reason: "signature_invalid_json" };
  }
  const envelope = record(parsed);
  if (
    !envelope ||
    !exactShape(envelope, [
      "schema",
      "scheme",
      "domain",
      "key_id",
      "response_sha256",
      "preimage_sha256",
      "signature_b64",
    ])
  ) {
    return { outcome: "rejected", reason: "signature_shape_mismatch" };
  }
  if (envelope.schema !== SYSTEM_ONE_SIGNATURE_SCHEMA) {
    return { outcome: "rejected", reason: "signature_schema_mismatch" };
  }
  if (envelope.scheme !== "ed25519") {
    return { outcome: "rejected", reason: "signature_scheme_mismatch" };
  }
  if (envelope.domain !== SYSTEM_ONE_SIGNATURE_DOMAIN) {
    return { outcome: "rejected", reason: "signature_domain_mismatch" };
  }
  if (envelope.key_id !== SIGNATURE_POLICY.keyId) {
    return { outcome: "rejected", reason: "signature_key_id_mismatch" };
  }

  const responseBytes = Buffer.from(responseRaw, "utf8");
  const responseSha256 = sha256(responseBytes);
  if (envelope.response_sha256 !== responseSha256) {
    return { outcome: "rejected", reason: "signature_response_hash_mismatch" };
  }

  const preimage = Buffer.concat([
    Buffer.from(SYSTEM_ONE_SIGNATURE_DOMAIN + "\0", "utf8"),
    responseBytes,
  ]);
  const preimageSha256 = sha256(preimage);
  if (envelope.preimage_sha256 !== preimageSha256) {
    return { outcome: "rejected", reason: "signature_preimage_hash_mismatch" };
  }

  const signatureB64 =
    typeof envelope.signature_b64 === "string" ? envelope.signature_b64 : "";
  if (
    signatureB64.length === 0 ||
    signatureB64.length > 128 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureB64)
  ) {
    return { outcome: "rejected", reason: "signature_encoding_invalid" };
  }
  const signature = Buffer.from(signatureB64, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signatureB64
  ) {
    return { outcome: "rejected", reason: "signature_encoding_invalid" };
  }

  if (!verifySignature(null, preimage, SIGNATURE_POLICY.key, signature)) {
    return { outcome: "rejected", reason: "signature_invalid" };
  }

  return {
    outcome: "verified",
    keyId: SIGNATURE_POLICY.keyId,
    publicKeySha256: SIGNATURE_POLICY.publicKeySha256,
    responseSha256,
    preimageSha256,
  };
}
