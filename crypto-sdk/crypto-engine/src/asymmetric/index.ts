/**
 * @module asymmetric
 *
 * Higher-level public-key operations over Sprint 1's X25519/Ed25519: key
 * agreement with contributory-behaviour protection, public-key validation
 * (including X25519 small-order-point rejection), key fingerprints, and
 * constant-time public-key comparison. Future modules use these instead of the
 * low-level SDK/`node:crypto` calls.
 */

import {
  AsymmetricAlgorithm,
  KeyPair,
  PrivateKey,
  PublicKey,
  SharedSecret,
  constantTimeEqual,
  deriveSharedSecret,
  fromHex,
  generateKeyPair,
  sha256,
  toBase64,
  toHex,
} from "@securechat/crypto-sdk";
import { PublicKeyValidationError } from "../errors/index.js";

/**
 * Canonical X25519 small-order (low-order) point encodings, per libsodium /
 * RFC 7748. Accepting these as a peer public key can force a predictable /
 * zero shared secret; we reject them. The top (255th) bit is masked before
 * comparison, matching X25519's u-coordinate decoding.
 */
const X25519_SMALL_ORDER_POINTS: readonly Uint8Array[] = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map(fromHex);

/** Whether a 32-byte X25519 u-coordinate is a known small-order point. */
export function isX25519SmallOrderPoint(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  const masked = raw.slice();
  masked[31] = masked[31]! & 0x7f; // ignore the unused high bit
  let hit = false;
  for (const bad of X25519_SMALL_ORDER_POINTS) {
    // Constant-time per-entry compare; OR the results (no early exit).
    hit = constantTimeEqual(masked, bad) || hit;
  }
  return hit;
}

/** Options for {@link fingerprint}. */
export interface FingerprintOptions {
  /** Output encoding (default `"hex"`). */
  encoding?: "hex" | "base64";
}

/** Compute a stable fingerprint (SHA-256 of the raw public key). */
export function fingerprint(publicKey: PublicKey, options: FingerprintOptions = {}): string {
  const digest = sha256(publicKey.toRaw());
  return options.encoding === "base64" ? toBase64(digest) : toHex(digest);
}

/**
 * Render a fingerprint as space-separated 4-character groups — a human-verifiable
 * "safety number" style string. Purely presentational.
 * @example fingerprintSegments(pub) // "ab12 cd34 ef56 ..."
 */
export function fingerprintSegments(publicKey: PublicKey, groupSize = 4): string {
  const hex = fingerprint(publicKey, { encoding: "hex" });
  return hex.match(new RegExp(`.{1,${groupSize}}`, "g"))?.join(" ") ?? hex;
}

/**
 * Reusable public-key operations. Stateless; construct once and reuse.
 *
 * @example
 * ```ts
 * const engine = new AsymmetricEngine();
 * const a = engine.generateKeyAgreementKeyPair();
 * const b = engine.generateKeyAgreementKeyPair();
 * engine.validatePublicKey(b.publicKey);
 * const secret = engine.agree(a.privateKey, b.publicKey);
 * const key = secret.deriveKey({ info: "demo" });
 * ```
 */
export class AsymmetricEngine {
  /** Generate an X25519 key-agreement key pair. */
  generateKeyAgreementKeyPair(): KeyPair {
    return generateKeyPair(AsymmetricAlgorithm.X25519);
  }

  /**
   * Compute the X25519 shared secret, rejecting small-order peer keys and any
   * all-zero (non-contributory) result.
   * @throws {PublicKeyValidationError} if the peer key is unsafe.
   */
  agree(privateKey: PrivateKey, publicKey: PublicKey): SharedSecret {
    this.validatePublicKey(publicKey);
    const secret = deriveSharedSecret(privateKey, publicKey);
    if (this.isAllZero(secret.bytes)) {
      throw new PublicKeyValidationError("Key agreement produced an all-zero shared secret (unsafe peer key)");
    }
    return secret;
  }

  /**
   * Validate a public key: supported algorithm, correct 32-byte length, and — for
   * X25519 — not a known small-order point.
   * @throws {PublicKeyValidationError}
   */
  validatePublicKey(publicKey: PublicKey): void {
    if (!(publicKey instanceof PublicKey)) {
      throw new PublicKeyValidationError("Expected a PublicKey");
    }
    const raw = publicKey.toRaw();
    if (raw.length !== 32) {
      throw new PublicKeyValidationError(`Public key must be 32 bytes, got ${raw.length}`);
    }
    if (
      publicKey.algorithm === AsymmetricAlgorithm.X25519 &&
      isX25519SmallOrderPoint(raw)
    ) {
      throw new PublicKeyValidationError("X25519 public key is a small-order point");
    }
  }

  /**
   * Import and validate a raw 32-byte public key.
   * @throws {PublicKeyValidationError}
   */
  importValidatedPublicKey(raw: Uint8Array, algorithm: AsymmetricAlgorithm): PublicKey {
    let key: PublicKey;
    try {
      key = PublicKey.fromRaw(raw, algorithm);
    } catch (cause) {
      throw new PublicKeyValidationError("Failed to import raw public key", { cause });
    }
    this.validatePublicKey(key);
    return key;
  }

  /** Fingerprint a public key (see {@link fingerprint}). */
  fingerprint(publicKey: PublicKey, options?: FingerprintOptions): string {
    return fingerprint(publicKey, options);
  }

  /** Constant-time equality of two public keys (same curve + point). */
  comparePublicKeys(a: PublicKey, b: PublicKey): boolean {
    return a.equals(b);
  }

  private isAllZero(bytes: Uint8Array): boolean {
    return constantTimeEqual(bytes, new Uint8Array(bytes.length));
  }
}
