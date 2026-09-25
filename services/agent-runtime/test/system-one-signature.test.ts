import { describe, expect, test } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSystemOneSignatureVerifier,
  SYSTEM_ONE_SIGNATURE_DOMAIN,
  SYSTEM_ONE_SIGNATURE_SCHEMA,
} from "../src/system-one-signature";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signedEnvelope(
  responseRaw: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
): string {
  const responseBytes = Buffer.from(responseRaw, "utf8");
  const preimage = Buffer.concat([
    Buffer.from(SYSTEM_ONE_SIGNATURE_DOMAIN + "\0", "utf8"),
    responseBytes,
  ]);
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return JSON.stringify({
    schema: SYSTEM_ONE_SIGNATURE_SCHEMA,
    scheme: "ed25519",
    domain: SYSTEM_ONE_SIGNATURE_DOMAIN,
    key_id: `ed25519:${sha256(der)}`,
    response_sha256: sha256(responseBytes),
    preimage_sha256: sha256(preimage),
    signature_b64: sign(null, preimage, privateKey).toString("base64"),
  });
}

function withPublicKey(
  fn: (input: {
    publicKeyPath: string;
    privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
    publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
  }) => void,
): void {
  const root = mkdtempSync(path.join(tmpdir(), "local-studio-s1-signature-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPath = path.join(root, "producer-public.pem");
    writeFileSync(
      publicKeyPath,
      publicKey.export({ type: "spki", format: "pem" }),
    );
    fn({ publicKeyPath, privateKey, publicKey });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("System-One detached signature policy", () => {
  test("verifies exact signed response bytes", () => {
    withPublicKey(({ publicKeyPath, privateKey, publicKey }) => {
      const raw = '{"id":"resp_signed","model":"script/s1"}\n';
      const verifier = createSystemOneSignatureVerifier({
        LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH: publicKeyPath,
      });
      const result = verifier(
        raw,
        signedEnvelope(raw, privateKey, publicKey),
      );
      expect(result.outcome).toBe("verified");
      if (result.outcome === "verified") {
        expect(result.responseSha256).toBe(sha256(raw));
        expect(result.keyId.startsWith("ed25519:")).toBe(true);
      }
    });
  });

  test("rejects one-byte response tampering", () => {
    withPublicKey(({ publicKeyPath, privateKey, publicKey }) => {
      const raw = '{"id":"resp_signed","model":"script/s1"}\n';
      const verifier = createSystemOneSignatureVerifier({
        LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH: publicKeyPath,
      });
      const result = verifier(
        raw.replace("script/s1", "script/s2"),
        signedEnvelope(raw, privateKey, publicKey),
      );
      expect(result).toEqual({
        outcome: "rejected",
        reason: "signature_response_hash_mismatch",
      });
    });
  });

  test("accepts a separately pinned expected key id", () => {
    withPublicKey(({ publicKeyPath, privateKey, publicKey }) => {
      const raw = '{"id":"resp_signed","model":"script/s1"}\n';
      const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const verifier = createSystemOneSignatureVerifier({
        LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH: publicKeyPath,
        LOCAL_STUDIO_SYSTEM_ONE_EXPECTED_KEY_ID: `ed25519:${sha256(der)}`,
      });
      expect(
        verifier(raw, signedEnvelope(raw, privateKey, publicKey)).outcome,
      ).toBe("verified");
    });
  });

  test("fails closed when the public key no longer matches the pinned key id", () => {
    withPublicKey(({ publicKeyPath }) => {
      withPublicKey(({ publicKey: expectedKey }) => {
        const expectedDer = expectedKey.export({
          type: "spki",
          format: "der",
        }) as Buffer;
        const verifier = createSystemOneSignatureVerifier({
          LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH: publicKeyPath,
          LOCAL_STUDIO_SYSTEM_ONE_EXPECTED_KEY_ID:
            `ed25519:${sha256(expectedDer)}`,
        });
        expect(verifier('{"id":"resp_signed"}\n', null)).toEqual({
          outcome: "rejected",
          reason: "signature_expected_key_id_mismatch",
        });
      });
    });
  });

  test("rejects malformed expected key id configuration", () => {
    withPublicKey(({ publicKeyPath }) => {
      const verifier = createSystemOneSignatureVerifier({
        LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH: publicKeyPath,
        LOCAL_STUDIO_SYSTEM_ONE_EXPECTED_KEY_ID: "ed25519:not-a-hash",
      });
      expect(verifier('{"id":"resp_signed"}\n', null)).toEqual({
        outcome: "rejected",
        reason: "signature_expected_key_id_invalid",
      });
    });
  });

  test("rejects wrong verification key", () => {
    withPublicKey(({ privateKey, publicKey }) => {
      withPublicKey(({ publicKeyPath }) => {
        const raw = '{"id":"resp_signed","model":"script/s1"}\n';
        const verifier = createSystemOneSignatureVerifier({
          LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH: publicKeyPath,
        });
        expect(
          verifier(raw, signedEnvelope(raw, privateKey, publicKey)),
        ).toEqual({
          outcome: "rejected",
          reason: "signature_key_id_mismatch",
        });
      });
    });
  });

  test("rejects signed response when no verification key is configured", () => {
    withPublicKey(({ privateKey, publicKey }) => {
      const raw = '{"id":"resp_signed","model":"script/s1"}\n';
      const verifier = createSystemOneSignatureVerifier({});
      expect(
        verifier(raw, signedEnvelope(raw, privateKey, publicKey)),
      ).toEqual({
        outcome: "rejected",
        reason: "signature_key_unconfigured",
      });
    });
  });

  test("rejects unsigned downgrade when a verification key is configured", () => {
    withPublicKey(({ publicKeyPath }) => {
      const verifier = createSystemOneSignatureVerifier({
        LOCAL_STUDIO_SYSTEM_ONE_PUBLIC_KEY_PATH: publicKeyPath,
      });
      expect(verifier('{"id":"resp_unsigned"}\n', null)).toEqual({
        outcome: "rejected",
        reason: "signature_required",
      });
    });
  });

  test("keeps legacy unsigned mode only when no signature policy exists", () => {
    const verifier = createSystemOneSignatureVerifier({});
    expect(verifier('{"id":"resp_legacy"}\n', null)).toEqual({
      outcome: "unsigned",
    });
  });
});
