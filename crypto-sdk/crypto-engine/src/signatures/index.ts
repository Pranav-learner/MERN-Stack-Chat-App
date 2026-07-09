/**
 * @module signatures
 *
 * The digital-signature engine over Sprint 1's Ed25519. Adds a signing framework
 * with signature metadata, attached and detached {@link SignedPayload}s, tamper
 * detection, and serialization.
 */

import {
  PrivateKey,
  PublicKey,
  Signature,
  coerceToBytes,
  sign as sdkSign,
  verify as sdkVerify,
} from "@securechat/crypto-sdk";
import type { Clock } from "../types/index.js";
import { SignedPayload, type SignatureMetadata } from "../payloads/index.js";
import { fingerprint } from "../asymmetric/index.js";

/** Options for the signature engine. */
export interface SignatureEngineOptions {
  /** Injectable clock (epoch ms) for signature timestamps. Default: `Date.now`. */
  clock?: Clock;
}

/**
 * A reusable Ed25519 signing framework.
 *
 * @example
 * ```ts
 * import { generateSigningKeyPair } from "@securechat/crypto-sdk";
 * const engine = new SignatureEngine();
 * const kp = generateSigningKeyPair();
 *
 * // Attached: payload travels with the signature.
 * const signed = engine.signPayload(kp.privateKey, "contract v1");
 * engine.verifyPayload(kp.publicKey, signed); // true
 *
 * // Detached: signature only; the verifier supplies the message.
 * const detached = engine.signDetached(kp.privateKey, fileBytes);
 * engine.verifyPayload(kp.publicKey, detached, fileBytes); // true
 * ```
 */
export class SignatureEngine {
  private readonly clock: Clock;

  constructor(options: SignatureEngineOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Sign a message, returning the raw {@link Signature}. @throws {InvalidKeyError} */
  sign(privateKey: PrivateKey, message: Uint8Array | string): Signature {
    return sdkSign(privateKey, message);
  }

  /**
   * Verify a raw signature over a message.
   * @returns `true` iff valid; `false` for wrong key, tampered message, or a
   *   malformed/wrong-length signature.
   */
  verify(publicKey: PublicKey, message: Uint8Array | string, signature: Signature): boolean {
    return sdkVerify(publicKey, message, signature);
  }

  /**
   * Sign, producing a {@link SignedPayload} with metadata. By default the payload
   * is attached; pass `{ attach: false }` for a detached signature.
   */
  signPayload(
    privateKey: PrivateKey,
    message: Uint8Array | string,
    options: { attach?: boolean } = {},
  ): SignedPayload {
    const messageBytes = coerceToBytes(message, "message");
    const signature = sdkSign(privateKey, messageBytes);
    const metadata: SignatureMetadata = {
      version: 1,
      algorithm: "ed25519",
      signerFingerprint: fingerprint(privateKey.toPublicKey()),
      createdAt: new Date(this.clock()).toISOString(),
    };
    const attach = options.attach !== false;
    return new SignedPayload(signature, metadata, attach ? messageBytes : undefined);
  }

  /** Sign, producing a detached {@link SignedPayload} (no attached payload). */
  signDetached(privateKey: PrivateKey, message: Uint8Array | string): SignedPayload {
    return this.signPayload(privateKey, message, { attach: false });
  }

  /**
   * Verify a {@link SignedPayload}. For an attached payload, `message` may be
   * omitted (the attached bytes are used). For a detached payload, `message` is
   * REQUIRED. If both are provided, they must match.
   *
   * @returns `true` iff the signature authenticates the resolved message.
   */
  verifyPayload(
    publicKey: PublicKey,
    signed: SignedPayload,
    message?: Uint8Array | string,
  ): boolean {
    let resolved: Uint8Array;
    if (signed.payload !== undefined) {
      resolved = signed.payload;
      if (message !== undefined) {
        // If the caller also supplies a message, ensure it matches the attached one.
        const provided = coerceToBytes(message, "message");
        if (!equalBytes(provided, resolved)) return false;
      }
    } else {
      if (message === undefined) return false; // detached needs a message
      resolved = coerceToBytes(message, "message");
    }
    return sdkVerify(publicKey, resolved, signed.signature);
  }
}

/** Re-exported for convenience. */
export { SignedPayload, type SignatureMetadata } from "../payloads/index.js";

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
