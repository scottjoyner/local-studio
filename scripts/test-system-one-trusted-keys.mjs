#!/usr/bin/env node

import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTrustedKey,
  parseTrustedKeyStore,
  readTrustedKeyStore,
  requireTrustedKey,
} from "./system-one-trusted-keys.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identity(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    keyId: "ed25519:" + sha256(der),
    publicKeySha256: sha256(der),
  };
}

function entry(role, identity, overrides = {}) {
  return {
    role,
    key_id: identity.keyId,
    public_key_sha256: identity.publicKeySha256,
    active_from: "2026-09-25T00:00:00Z",
    retire_after: null,
    revoked_at: null,
    note: null,
    ...overrides,
  };
}

function store(entries) {
  return {
    schema: "system-one-trusted-keys-v1",
    keys: [...entries].sort((left, right) =>
      `${left.role}\0${left.key_id}`.localeCompare(
        `${right.role}\0${right.key_id}`,
      ),
    ),
  };
}

function expectFailure(fn, pattern) {
  let failed = false;
  try {
    fn();
  } catch (error) {
    failed = true;
    if (pattern && !pattern.test(String(error?.message ?? error))) {
      throw error;
    }
  }
  if (!failed) throw new Error("Expected operation to fail");
}

const producer = identity(generateKeyPairSync("ed25519").publicKey);
const evidence = identity(generateKeyPairSync("ed25519").publicKey);

const parsed = parseTrustedKeyStore(
  store([entry("producer", producer), entry("consumer_evidence", evidence)]),
);

requireTrustedKey({
  store: parsed,
  role: "producer",
  keyId: producer.keyId,
  publicKeySha256: producer.publicKeySha256,
  at: "2026-09-25T12:00:00Z",
});
requireTrustedKey({
  store: parsed,
  role: "consumer_evidence",
  keyId: evidence.keyId,
  publicKeySha256: evidence.publicKeySha256,
  at: "2026-09-25T12:00:00Z",
});

if (
  checkTrustedKey({
    store: parsed,
    role: "consumer_evidence",
    keyId: producer.keyId,
    publicKeySha256: producer.publicKeySha256,
    at: "2026-09-25T12:00:00Z",
  }).reason !== "key_role_mismatch"
) {
  throw new Error("Trust store did not reject cross-role key reuse");
}

const retired = parseTrustedKeyStore(
  store([
    entry("producer", producer, {
      retire_after: "2026-09-25T11:00:00Z",
    }),
  ]),
);
if (
  checkTrustedKey({
    store: retired,
    role: "producer",
    keyId: producer.keyId,
    publicKeySha256: producer.publicKeySha256,
    at: "2026-09-25T10:00:00Z",
  }).valid !== true
) {
  throw new Error("Historical evidence captured before retirement should remain valid");
}
if (
  checkTrustedKey({
    store: retired,
    role: "producer",
    keyId: producer.keyId,
    publicKeySha256: producer.publicKeySha256,
    at: "2026-09-25T12:00:00Z",
  }).reason !== "key_retired"
) {
  throw new Error("Trust store did not reject post-retirement evidence");
}

const revoked = parseTrustedKeyStore(
  store([
    entry("producer", producer, {
      revoked_at: "2026-09-25T11:00:00Z",
    }),
  ]),
);
if (
  checkTrustedKey({
    store: revoked,
    role: "producer",
    keyId: producer.keyId,
    publicKeySha256: producer.publicKeySha256,
    at: "2026-09-25T10:00:00Z",
  }).reason !== "key_revoked"
) {
  throw new Error("Revocation must reject even historical evidence");
}

expectFailure(
  () =>
    parseTrustedKeyStore({
      schema: "system-one-trusted-keys-v1",
      keys: [
        entry("producer", producer),
        entry("consumer_evidence", producer),
      ],
    }),
  /may not appear/,
);

expectFailure(
  () =>
    parseTrustedKeyStore(
      store([
        entry("producer", producer, {
          public_key_sha256: "0".repeat(64),
        }),
      ]),
    ) &&
    requireTrustedKey({
      store: parseTrustedKeyStore(
        store([
          entry("producer", producer, {
            public_key_sha256: "0".repeat(64),
          }),
        ]),
      ),
      role: "producer",
      keyId: producer.keyId,
      publicKeySha256: producer.publicKeySha256,
      at: "2026-09-25T12:00:00Z",
    }),
  /public_key_hash_mismatch/,
);

const root = mkdtempSync(join(tmpdir(), "local-studio-system-one-trust-"));
try {
  const path = join(root, "trusted-keys.json");
  writeFileSync(
    path,
    JSON.stringify(
      store([entry("producer", producer), entry("consumer_evidence", evidence)]),
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  const loaded = readTrustedKeyStore(path);
  if (!loaded || !/^[0-9a-f]{64}$/.test(loaded.sha256)) {
    throw new Error("Protected trust store did not load with a stable file hash");
  }

  chmodSync(path, 0o666);
  expectFailure(() => readTrustedKeyStore(path), /must not be group\/other writable/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("System-One trusted key store self-test passed.\n");
