/**
 * @module shs/key-agreement/derivation
 *
 * Shared-secret establishment. Combines a local ephemeral PRIVATE key with a peer's
 * ephemeral PUBLIC key to derive an X25519 shared secret that is **never
 * transmitted** — both parties compute the identical value independently.
 *
 * Also provides the one-way **commitment** used to verify (out-of-band or via the
 * relay) that both parties derived the same secret WITHOUT revealing it, and secure
 * **disposal** of the transient secret bytes.
 *
 * @security This module derives a raw shared secret ONLY. It does NOT run a KDF and
 * does NOT produce encryption keys (a future sprint does). Secret `Buffer`s are
 * zero-filled on disposal; callers must not retain references after `dispose()`.
 */

import {
  deriveSharedSecret as x25519Derive,
  secretCommitment,
  constantTimeEqual,
} from "../crypto/x25519.js";
import { SharedSecretError, SharedSecretMismatchError } from "../errors.js";
import { X25519_SHARED_SECRET_BYTES } from "../types.js";

/**
 * Derive the shared secret for one party.
 *
 * @param {import("crypto").KeyObject} ownPrivateKey local ephemeral private key
 * @param {Buffer|string} peerPublicKey peer ephemeral public key (raw Buffer / base64)
 * @returns {{ secret: Buffer, fingerprint: string, commitment: string, length: number }}
 *   `secret` is device-local — dispose it with {@link disposeSecret} after use.
 * @throws {InvalidPublicKeyError | SharedSecretError}
 *
 * @example
 * ```js
 * const { secret, commitment } = deriveSecret(myEphemeralPriv, peerEphemeralPubB64);
 * // publish `commitment` (safe); keep `secret` local; later: disposeSecret(secret)
 * ```
 */
export function deriveSecret(ownPrivateKey, peerPublicKey) {
  const secret = x25519Derive(ownPrivateKey, peerPublicKey); // validates + rejects unsafe
  if (secret.length !== X25519_SHARED_SECRET_BYTES) {
    disposeSecret(secret);
    throw new SharedSecretError(`Unexpected shared-secret length: ${secret.length}`);
  }
  const commitment = secretCommitment(secret);
  return { secret, fingerprint: commitment, commitment, length: secret.length };
}

/**
 * Validate a derived secret is the expected length and non-trivial.
 * @param {Buffer} secret @throws {SharedSecretError}
 */
export function validateSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== X25519_SHARED_SECRET_BYTES) {
    throw new SharedSecretError("Shared secret is malformed or wrong length");
  }
  if (constantTimeEqual(secret, Buffer.alloc(secret.length))) {
    throw new SharedSecretError("Shared secret is all-zero");
  }
  return true;
}

/**
 * Compare two shared secrets in constant time (e.g. in a local both-sides test).
 * @param {Buffer} a @param {Buffer} b @returns {boolean}
 */
export function secretsEqual(a, b) {
  return constantTimeEqual(a, b);
}

/**
 * Verify two parties derived the same secret using their one-way commitments —
 * without either secret being present. Throws on mismatch.
 * @param {string} commitmentA @param {string} commitmentB
 * @throws {SharedSecretMismatchError}
 */
export function assertCommitmentsMatch(commitmentA, commitmentB) {
  if (
    typeof commitmentA !== "string" ||
    typeof commitmentB !== "string" ||
    !constantTimeEqual(Buffer.from(commitmentA), Buffer.from(commitmentB))
  ) {
    throw new SharedSecretMismatchError();
  }
  return true;
}

/** Non-throwing commitment comparison. */
export function commitmentsMatch(commitmentA, commitmentB) {
  try {
    return assertCommitmentsMatch(commitmentA, commitmentB);
  } catch {
    return false;
  }
}

/** The one-way commitment for a secret (re-exported for convenience). */
export { secretCommitment };

/**
 * Securely dispose of a shared-secret buffer by zero-filling it. Call as soon as the
 * secret has been persisted to secure storage / consumed. Idempotent and safe on
 * non-buffers.
 * @param {Buffer} secret
 */
export function disposeSecret(secret) {
  if (Buffer.isBuffer(secret)) secret.fill(0);
}
