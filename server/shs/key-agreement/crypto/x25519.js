/**
 * @module shs/key-agreement/crypto/x25519
 *
 * Low-level X25519 key-agreement primitives, built on Node's `crypto` (zero deps).
 * These mirror the Layer 2 Crypto SDK's `AsymmetricEngine` behaviour — same
 * algorithm, same 32-byte raw base64 key format as Layer 3 identities, and the same
 * two mandatory safety checks:
 *
 *   1. **Small-order (low-order) point rejection** — reject the canonical X25519
 *      points that force a predictable / zero shared secret (RFC 7748 / libsodium).
 *   2. **All-zero output rejection** — reject a non-contributory shared secret.
 *
 * @security Private keys are Node `KeyObject`s that never leave the process that
 * created them; raw private bytes are never exported. The shared secret is returned
 * as a `Buffer` the caller must dispose of (see {@link module:shs/key-agreement/derivation}).
 * This module performs NO KDF and derives NO encryption keys.
 */

import crypto from "node:crypto";
import { InvalidPublicKeyError, SharedSecretError, EphemeralKeyError } from "../errors.js";
import { X25519_PUBLIC_KEY_BYTES, X25519_SHARED_SECRET_BYTES } from "../types.js";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Canonical X25519 small-order point encodings (RFC 7748 / libsodium). Accepting one
 * of these as a peer public key can force a predictable/zero shared secret.
 * @type {Buffer[]}
 */
const SMALL_ORDER_POINTS = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((h) => Buffer.from(h, "hex"));

/** Constant-time buffer equality (length-safe). */
export function constantTimeEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Whether a 32-byte X25519 u-coordinate is a known small-order point. The unused
 * high bit is masked before comparison (matching X25519 u-coordinate decoding).
 * @param {Buffer} raw @returns {boolean}
 */
export function isSmallOrderPoint(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== X25519_PUBLIC_KEY_BYTES) return false;
  const masked = Buffer.from(raw);
  masked[31] &= 0x7f;
  let hit = false;
  for (const bad of SMALL_ORDER_POINTS) {
    // OR (no early exit) to keep the scan constant-time across the table.
    hit = constantTimeEqual(masked, bad) || hit;
  }
  return hit;
}

/**
 * Generate a fresh ephemeral X25519 key pair.
 * @returns {{ privateKey: import("crypto").KeyObject, publicKey: import("crypto").KeyObject, publicKeyRaw: string }}
 *   `publicKeyRaw` is base64 of the 32 raw public bytes.
 * @throws {EphemeralKeyError}
 */
export function generateKeyPair() {
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
    return { privateKey, publicKey, publicKeyRaw: exportRawPublicKey(publicKey) };
  } catch (error) {
    throw new EphemeralKeyError("Failed to generate X25519 key pair", { cause: error });
  }
}

/** Export a public `KeyObject` as base64 of its 32 raw bytes. */
export function exportRawPublicKey(publicKey) {
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return raw.toString("base64");
}

/**
 * Decode + length-check a base64 raw X25519 public key.
 * @param {string} publicKeyB64 @returns {Buffer} the 32 raw bytes
 * @throws {InvalidPublicKeyError}
 */
export function decodeRawPublicKey(publicKeyB64) {
  if (typeof publicKeyB64 !== "string" || publicKeyB64.length === 0 || !BASE64_RE.test(publicKeyB64)) {
    throw new InvalidPublicKeyError("Public key must be a non-empty base64 string");
  }
  const bytes = Buffer.from(publicKeyB64, "base64");
  if (bytes.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new InvalidPublicKeyError(
      `X25519 public key must be ${X25519_PUBLIC_KEY_BYTES} bytes, got ${bytes.length}`,
      { details: { length: bytes.length } },
    );
  }
  return bytes;
}

/**
 * Validate a raw public key: correct length and not a small-order point.
 * @param {Buffer|string} key raw bytes or base64
 * @returns {Buffer} the validated raw bytes
 * @throws {InvalidPublicKeyError}
 */
export function validateRawPublicKey(key) {
  const raw = Buffer.isBuffer(key) ? key : decodeRawPublicKey(key);
  if (raw.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new InvalidPublicKeyError(`X25519 public key must be ${X25519_PUBLIC_KEY_BYTES} bytes`);
  }
  if (isSmallOrderPoint(raw)) {
    throw new InvalidPublicKeyError("X25519 public key is a small-order point", {
      details: { reason: "small-order-point" },
    });
  }
  return raw;
}

/** Import a validated raw/base64 X25519 public key into a `KeyObject`. */
export function importPublicKey(key) {
  const raw = validateRawPublicKey(key);
  try {
    return crypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
      format: "jwk",
    });
  } catch (error) {
    throw new InvalidPublicKeyError("Failed to import X25519 public key", { cause: error });
  }
}

/**
 * Derive the X25519 shared secret from a local private key and a peer public key,
 * rejecting small-order peer keys and any all-zero (non-contributory) output.
 *
 * @param {import("crypto").KeyObject} privateKey local ephemeral private key
 * @param {import("crypto").KeyObject|Buffer|string} peerPublicKey peer public key
 *   (KeyObject, raw Buffer, or base64)
 * @returns {Buffer} the 32-byte shared secret (caller MUST dispose)
 * @throws {InvalidPublicKeyError | SharedSecretError}
 */
export function deriveSharedSecret(privateKey, peerPublicKey) {
  const peer =
    peerPublicKey && typeof peerPublicKey === "object" && peerPublicKey.asymmetricKeyType
      ? peerPublicKey
      : importPublicKey(peerPublicKey); // validates length + small-order
  let secret;
  try {
    secret = crypto.diffieHellman({ privateKey, publicKey: peer });
  } catch (error) {
    throw new SharedSecretError("X25519 diffie-hellman failed", { cause: error });
  }
  if (secret.length !== X25519_SHARED_SECRET_BYTES || isAllZero(secret)) {
    secret.fill(0);
    throw new InvalidPublicKeyError("Key agreement produced an all-zero shared secret (unsafe peer key)", {
      details: { reason: "all-zero-secret" },
    });
  }
  return secret;
}

/** Whether a buffer is entirely zero (constant-time). */
export function isAllZero(buf) {
  return constantTimeEqual(buf, Buffer.alloc(buf.length));
}

/**
 * A one-way commitment to a shared secret, safe to transmit / compare out-of-band.
 * Domain-separated SHA-256 so it cannot be confused with any other hash of the
 * secret. Revealing the commitment does NOT reveal the secret.
 * @param {Buffer} sharedSecret @returns {string} hex
 */
export function secretCommitment(sharedSecret) {
  return crypto.createHash("sha256").update("SHS-KA-commit-v1").update(sharedSecret).digest("hex");
}

/**
 * A stable fingerprint of a raw public key (SHA-256 hex) — for logging/tracing.
 * @param {Buffer|string} key @returns {string} hex
 */
export function publicKeyFingerprint(key) {
  const raw = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// === optional identity binding (authenticated key exchange) ===============

/**
 * Sign a raw ephemeral public key with an Ed25519 identity private key (device-side).
 * @param {import("crypto").KeyObject} identityPrivateKey @param {Buffer|string} rawPublicKey
 * @returns {string} base64 signature
 */
export function signEphemeralKey(identityPrivateKey, rawPublicKey) {
  const data = Buffer.isBuffer(rawPublicKey) ? rawPublicKey : Buffer.from(rawPublicKey, "base64");
  return crypto.sign(null, data, identityPrivateKey).toString("base64");
}

/**
 * Verify an Ed25519 signature over a raw ephemeral public key against a raw identity
 * public key (base64). Non-throwing.
 * @param {Buffer|string} rawPublicKey the signed ephemeral public key
 * @param {string} signatureB64 @param {string} identityPublicKeyB64 raw Ed25519 key (base64)
 * @returns {boolean}
 */
export function verifyEphemeralKey(rawPublicKey, signatureB64, identityPublicKeyB64) {
  try {
    const data = Buffer.isBuffer(rawPublicKey) ? rawPublicKey : Buffer.from(rawPublicKey, "base64");
    const idRaw = Buffer.from(identityPublicKeyB64, "base64");
    const identityKey = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: idRaw.toString("base64url") },
      format: "jwk",
    });
    return crypto.verify(null, data, identityKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
