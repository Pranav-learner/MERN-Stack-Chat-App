/**
 * @module integrity
 *
 * Integrity verification utilities. Cryptographic authenticity is already
 * enforced by AEAD (decrypt throws on tamper) and Ed25519 (verify returns false);
 * this module adds:
 * - checksums for non-authenticated corruption detection,
 * - a non-throwing {@link IntegrityVerifier} that returns structured
 *   {@link IntegrityResult}s (ok/reason/code) for callers that prefer branching
 *   over try/catch,
 * - explicit version-mismatch detection.
 *
 * It detects: modified payloads, corrupted ciphertext, wrong keys, wrong
 * signatures, invalid metadata, and version mismatches.
 */

import {
  DecryptionError,
  EncryptedPayload,
  GCM_NONCE_BYTES,
  GCM_TAG_BYTES,
  HashAlgorithm,
  PublicKey,
  SymmetricKey,
  constantTimeEqual,
  decrypt,
  hash,
  toHex,
  utf8ToBytes,
} from "@securechat/crypto-sdk";
import type { IntegrityResult } from "../types/index.js";
import { SignedPayload } from "../payloads/index.js";
import { SignatureEngine } from "../signatures/index.js";
import { IntegrityError } from "../errors/index.js";

/** Compute a hex checksum (default SHA-256) of some bytes/string. */
export function computeChecksum(
  data: Uint8Array | string,
  algorithm: HashAlgorithm = HashAlgorithm.SHA256,
): string {
  return toHex(hash(data, algorithm));
}

/**
 * Verify a checksum in constant time.
 * @returns `true` iff `data`'s checksum equals `expected` (hex).
 */
export function verifyChecksum(
  data: Uint8Array | string,
  expected: string,
  algorithm: HashAlgorithm = HashAlgorithm.SHA256,
): boolean {
  const actual = computeChecksum(data, algorithm);
  return constantTimeEqual(utf8ToBytes(actual), utf8ToBytes(expected));
}

/**
 * Throwing checksum assertion.
 * @throws {IntegrityError} if the checksum does not match.
 */
export function assertChecksum(
  data: Uint8Array | string,
  expected: string,
  algorithm: HashAlgorithm = HashAlgorithm.SHA256,
): void {
  if (!verifyChecksum(data, expected, algorithm)) {
    throw new IntegrityError("Checksum mismatch: data is corrupted or modified");
  }
}

const ok: IntegrityResult = { ok: true };
function fail(code: string, reason: string): IntegrityResult {
  return { ok: false, code, reason };
}

/**
 * Non-throwing integrity checks returning structured results.
 *
 * @example
 * ```ts
 * const verifier = new IntegrityVerifier();
 * const r = verifier.tryDecrypt(key, payload);
 * if (!r.ok) console.warn(r.code, r.reason);
 * ```
 */
export class IntegrityVerifier {
  private readonly signatures = new SignatureEngine();

  /** Structurally validate an {@link EncryptedPayload} (nonce/tag lengths, algorithm). */
  checkEncryptedPayload(payload: EncryptedPayload): IntegrityResult {
    if (!(payload instanceof EncryptedPayload)) return fail("not-a-payload", "not an EncryptedPayload");
    if (payload.nonce.length !== GCM_NONCE_BYTES) return fail("bad-nonce", "invalid nonce length");
    if (payload.authTag.length !== GCM_TAG_BYTES) return fail("bad-tag", "invalid auth tag length");
    return ok;
  }

  /** Detect a version mismatch. */
  checkVersion(actual: number, expected: number): IntegrityResult {
    return actual === expected ? ok : fail("version-mismatch", `expected v${expected}, got v${actual}`);
  }

  /**
   * Attempt to decrypt without throwing. Returns `{ ok: true, plaintext }` or a
   * failure result. A failure means tampered ciphertext, a wrong key, a wrong
   * nonce, or wrong/missing AAD (indistinguishable by design).
   */
  tryDecrypt(
    key: SymmetricKey,
    payload: EncryptedPayload,
    options: { aad?: Uint8Array | string } = {},
  ): IntegrityResult & { plaintext?: Uint8Array } {
    const structural = this.checkEncryptedPayload(payload);
    if (!structural.ok) return structural;
    try {
      const plaintext = decrypt(key, payload, options);
      return { ok: true, plaintext };
    } catch (cause) {
      if (cause instanceof DecryptionError) {
        return fail("authentication-failed", "ciphertext is tampered, or key/nonce/AAD is wrong");
      }
      return fail("decrypt-error", cause instanceof Error ? cause.message : "unknown error");
    }
  }

  /**
   * Verify a {@link SignedPayload} without throwing.
   * @param message required for detached payloads.
   */
  verifySignedPayload(
    publicKey: PublicKey,
    signed: SignedPayload,
    message?: Uint8Array | string,
  ): IntegrityResult {
    if (!(signed instanceof SignedPayload)) return fail("not-a-signed-payload", "not a SignedPayload");
    if (signed.isDetached && message === undefined) {
      return fail("missing-message", "detached signature requires the message");
    }
    const valid = this.signatures.verifyPayload(publicKey, signed, message);
    return valid ? ok : fail("bad-signature", "signature does not verify");
  }
}
