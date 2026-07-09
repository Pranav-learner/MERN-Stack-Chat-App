/**
 * @module signatures
 *
 * Digital signatures using **Ed25519** (EdDSA over Curve25519).
 *
 * Ed25519 is deterministic, fast, misuse-resistant (no per-signature randomness
 * to get wrong), and produces compact 64-byte signatures. Backed by Node/OpenSSL
 * `sign` / `verify` (the `algorithm` argument is `null` for Ed25519).
 */

import { sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { AsymmetricAlgorithm } from "../constants/index.js";
import { InvalidKeyError } from "../errors/index.js";
import { coerceToBytes } from "../utils/index.js";
import { KeyPair, PrivateKey, PublicKey, Signature } from "../keys/index.js";

/**
 * Generate an Ed25519 key pair for signing/verification.
 *
 * @example
 * ```ts
 * const identity = generateSigningKeyPair();
 * const sig = sign(identity.privateKey, "hello");
 * const ok = verify(identity.publicKey, "hello", sig); // true
 * ```
 */
export function generateSigningKeyPair(): KeyPair {
  return KeyPair.generate(AsymmetricAlgorithm.ED25519);
}

/**
 * Sign `message` with an Ed25519 private key.
 *
 * @param privateKey an Ed25519 {@link PrivateKey}.
 * @param message bytes, or a string (encoded as UTF-8).
 * @returns a 64-byte {@link Signature}.
 * @throws {InvalidKeyError} if the key is not Ed25519 or signing fails.
 */
export function sign(privateKey: PrivateKey, message: Uint8Array | string): Signature {
  if (!(privateKey instanceof PrivateKey)) {
    throw new InvalidKeyError("privateKey must be a PrivateKey");
  }
  if (privateKey.algorithm !== AsymmetricAlgorithm.ED25519) {
    throw new InvalidKeyError("Signing requires an Ed25519 private key");
  }
  try {
    // For Ed25519 the digest algorithm argument must be null.
    const sig = nodeSign(null, coerceToBytes(message, "message"), privateKey.native);
    return Signature.fromBytes(new Uint8Array(sig));
  } catch (cause) {
    throw new InvalidKeyError("Ed25519 signing failed", { cause });
  }
}

/**
 * Verify an Ed25519 signature over `message`.
 *
 * Returns a boolean rather than throwing on a bad signature: a wrong key, a
 * tampered message, or a malformed/wrong-length signature all yield `false`.
 * It DOES throw for programmer error (e.g. passing a non-Ed25519 key).
 *
 * @param publicKey an Ed25519 {@link PublicKey}.
 * @param message the message that was supposedly signed.
 * @param signature the {@link Signature} to check.
 * @returns `true` iff the signature is valid for `(publicKey, message)`.
 * @throws {InvalidKeyError} if `publicKey` is not an Ed25519 key.
 *
 * @example
 * ```ts
 * if (!verify(pub, message, sig)) throw new Error("signature rejected");
 * ```
 */
export function verify(
  publicKey: PublicKey,
  message: Uint8Array | string,
  signature: Signature,
): boolean {
  if (!(publicKey instanceof PublicKey)) {
    throw new InvalidKeyError("publicKey must be a PublicKey");
  }
  if (publicKey.algorithm !== AsymmetricAlgorithm.ED25519) {
    throw new InvalidKeyError("Verification requires an Ed25519 public key");
  }
  if (!(signature instanceof Signature)) {
    throw new InvalidKeyError("signature must be a Signature");
  }
  try {
    return nodeVerify(null, coerceToBytes(message, "message"), publicKey.native, signature.bytes);
  } catch {
    // A malformed signature buffer can make OpenSSL throw; that is still "invalid".
    return false;
  }
}
