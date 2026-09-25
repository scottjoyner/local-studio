import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";

export const SYSTEM_ONE_TRUSTED_KEYS_SCHEMA = "system-one-trusted-keys-v1";
export const SYSTEM_ONE_TRUSTED_KEY_ROLES = new Set([
  "producer",
  "consumer_evidence",
]);

const KEY_ID_RE = /^ed25519:[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !RFC3339_RE.test(value)) {
    throw new Error(`${label} must be RFC3339 with an explicit timezone`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`${label} is not a valid timestamp`);
  }
  return millis;
}

function optionalTimestamp(value, label) {
  if (value == null) return null;
  return parseTimestamp(value, label);
}

function validateEntry(entry, index) {
  const label = `trusted key entry ${index}`;
  if (
    !exactKeys(entry, [
      "role",
      "key_id",
      "public_key_sha256",
      "active_from",
      "retire_after",
      "revoked_at",
      "note",
    ])
  ) {
    throw new Error(`${label} has an unexpected shape`);
  }
  if (!SYSTEM_ONE_TRUSTED_KEY_ROLES.has(entry.role)) {
    throw new Error(`${label} has an unsupported role`);
  }
  if (typeof entry.key_id !== "string" || !KEY_ID_RE.test(entry.key_id)) {
    throw new Error(`${label} has an invalid Ed25519 key id`);
  }
  if (
    typeof entry.public_key_sha256 !== "string" ||
    !SHA256_RE.test(entry.public_key_sha256)
  ) {
    throw new Error(`${label} has an invalid public-key SHA-256`);
  }
  const activeFrom = parseTimestamp(entry.active_from, `${label}.active_from`);
  const retireAfter = optionalTimestamp(
    entry.retire_after,
    `${label}.retire_after`,
  );
  const revokedAt = optionalTimestamp(entry.revoked_at, `${label}.revoked_at`);
  if (retireAfter != null && retireAfter < activeFrom) {
    throw new Error(`${label} retires before activation`);
  }
  if (revokedAt != null && revokedAt < activeFrom) {
    throw new Error(`${label} is revoked before activation`);
  }
  if (
    entry.note !== null &&
    (typeof entry.note !== "string" || entry.note.length > 256)
  ) {
    throw new Error(`${label}.note must be null or a bounded string`);
  }
  return {
    ...entry,
    activeFromMillis: activeFrom,
    retireAfterMillis: retireAfter,
    revokedAtMillis: revokedAt,
  };
}

export function parseTrustedKeyStore(value) {
  if (!exactKeys(value, ["schema", "keys"])) {
    throw new Error("trusted key store has an unexpected shape");
  }
  if (value.schema !== SYSTEM_ONE_TRUSTED_KEYS_SCHEMA) {
    throw new Error("unsupported trusted key store schema");
  }
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 128) {
    throw new Error("trusted key store must contain 1..128 keys");
  }

  const seen = new Set();
  const keys = value.keys.map((entry, index) => {
    const validated = validateEntry(entry, index);
    if (seen.has(validated.key_id)) {
      throw new Error(
        "one Ed25519 key id may not appear in more than one trust-store entry or role",
      );
    }
    seen.add(validated.key_id);
    return validated;
  });

  const ordered = [...keys].sort((left, right) =>
    `${left.role}\0${left.key_id}`.localeCompare(
      `${right.role}\0${right.key_id}`,
    ),
  );
  if (
    keys.some(
      (entry, index) =>
        entry.role !== ordered[index].role || entry.key_id !== ordered[index].key_id,
    )
  ) {
    throw new Error("trusted key entries must be sorted by role then key_id");
  }

  return Object.freeze({
    schema: SYSTEM_ONE_TRUSTED_KEYS_SCHEMA,
    keys: Object.freeze(keys),
  });
}

export function readTrustedKeyStore(filepath) {
  if (!filepath) return null;
  if (!existsSync(filepath)) {
    throw new Error(`trusted key store does not exist: ${filepath}`);
  }
  const stat = lstatSync(filepath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > 64 * 1024
  ) {
    throw new Error(
      "trusted key store must be a bounded regular non-symlink file",
    );
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error("trusted key store must not be group/other writable");
  }
  const raw = readFileSync(filepath);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("trusted key store is not valid JSON");
  }
  return {
    ...parseTrustedKeyStore(parsed),
    path: filepath,
    sha256: sha256(raw),
  };
}

export function checkTrustedKey({
  store,
  role,
  keyId,
  publicKeySha256,
  at,
}) {
  if (!store) {
    return { valid: true, reason: "trust_store_not_configured", entry: null };
  }
  if (!SYSTEM_ONE_TRUSTED_KEY_ROLES.has(role)) {
    return { valid: false, reason: "unsupported_role", entry: null };
  }
  const entry = store.keys.find((candidate) => candidate.key_id === keyId) ?? null;
  if (!entry) {
    return { valid: false, reason: "key_id_not_trusted", entry: null };
  }
  if (entry.role !== role) {
    return { valid: false, reason: "key_role_mismatch", entry };
  }
  if (entry.public_key_sha256 !== publicKeySha256) {
    return { valid: false, reason: "public_key_hash_mismatch", entry };
  }
  if (entry.revoked_at !== null) {
    return { valid: false, reason: "key_revoked", entry };
  }

  let atMillis;
  try {
    atMillis = parseTimestamp(at, "evidence timestamp");
  } catch {
    return { valid: false, reason: "evidence_timestamp_invalid", entry };
  }
  if (atMillis < entry.activeFromMillis) {
    return { valid: false, reason: "key_not_active_yet", entry };
  }
  if (entry.retireAfterMillis != null && atMillis > entry.retireAfterMillis) {
    return { valid: false, reason: "key_retired", entry };
  }
  return { valid: true, reason: "trusted", entry };
}

export function requireTrustedKey(options) {
  const result = checkTrustedKey(options);
  if (!result.valid) {
    throw new Error(
      `trusted key policy rejected ${options.role} key ${options.keyId}: ${result.reason}`,
    );
  }
  return result.entry;
}
