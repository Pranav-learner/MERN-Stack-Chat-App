/**
 * @module asymmetric
 *
 * Public-key **key agreement** using **X25519** (Elliptic-Curve Diffie–Hellman).
 *
 * This module produces a {@link SharedSecret} that two parties can compute
 * independently from their own private key and the other's public key. It does
 * NOT encrypt on its own — derive a {@link SymmetricKey} from the shared secret
 * (via HKDF: `sharedSecret.deriveKey(...)`) and use the `symmetric` module.
 *
 * Backed by Node/OpenSSL `diffieHellman` and `generateKeyPair`.
 */

import { diffieHellman } from "node:crypto";
import { AsymmetricAlgorithm } from "../constants/index.js";
import { InvalidKeyError } from "../errors/index.js";
import { KeyPair, PrivateKey, PublicKey, SharedSecret } from "../keys/index.js";

/**
 * Generate an X25519 key pair for key agreement.
 *
 * @param algorithm defaults to X25519. (Ed25519 is accepted for symmetry but is a
 *   *signing* curve — pass it only if you intend to use the pair with the
 *   `signatures` module; it cannot be used for {@link deriveSharedSecret}.)
 *
 * @example
 * ```ts
 * const alice = generateKeyPair();
 * const bob = generateKeyPair();
 * ```
 */
export function generateKeyPair(
  algorithm: AsymmetricAlgorithm = AsymmetricAlgorithm.X25519,
): KeyPair {
  return KeyPair.generate(algorithm);
}

/**
 * Compute the X25519 shared secret between `privateKey` and `publicKey`.
 *
 * Both keys must be X25519. The result is symmetric:
 * `deriveSharedSecret(alicePriv, bobPub)` equals `deriveSharedSecret(bobPriv, alicePub)`.
 *
 * @throws {InvalidKeyError} if either key is not an X25519 key or agreement fails.
 *
 * @example
 * ```ts
 * const sAlice = deriveSharedSecret(alice.privateKey, bob.publicKey);
 * const key = sAlice.deriveKey({ info: "securechat:session:v1" });
 * ```
 */
export function deriveSharedSecret(privateKey: PrivateKey, publicKey: PublicKey): SharedSecret {
  if (!(privateKey instanceof PrivateKey)) {
    throw new InvalidKeyError("privateKey must be a PrivateKey");
  }
  if (!(publicKey instanceof PublicKey)) {
    throw new InvalidKeyError("publicKey must be a PublicKey");
  }
  if (privateKey.algorithm !== AsymmetricAlgorithm.X25519) {
    throw new InvalidKeyError("Key agreement requires an X25519 private key");
  }
  if (publicKey.algorithm !== AsymmetricAlgorithm.X25519) {
    throw new InvalidKeyError("Key agreement requires an X25519 public key");
  }
  try {
    const secret = diffieHellman({ privateKey: privateKey.native, publicKey: publicKey.native });
    return SharedSecret.fromBytes(new Uint8Array(secret));
  } catch (cause) {
    throw new InvalidKeyError("X25519 key agreement failed", { cause });
  }
}
