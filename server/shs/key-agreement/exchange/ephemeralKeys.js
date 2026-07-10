/**
 * @module shs/key-agreement/exchange/ephemeralKeys
 *
 * Ephemeral key lifecycle for key agreement. Each handshake mints a **fresh**
 * ephemeral X25519 key pair per party; keys are never reused across sessions. The
 * PUBLIC half is packaged into an {@link EphemeralPublicKeyBundle} for exchange; the
 * PRIVATE half is held in a local {@link EphemeralKeyStore} and destroyed after the
 * shared secret is derived.
 *
 * @security Private ephemeral keys never leave the store and are never serialized.
 * `destroy()` drops the reference (JS cannot forcibly wipe a `KeyObject`'s internal
 * bytes, but the raw bytes are never exposed and the object becomes GC-eligible).
 */

import crypto from "node:crypto";
import { generateKeyPair, exportRawPublicKey, signEphemeralKey } from "../crypto/x25519.js";
import { KeyAgreementAlgorithm } from "../types.js";
import { EphemeralKeyNotFoundError } from "../errors.js";

/** Ephemeral public-key bundle format version. */
export const EPHEMERAL_KEY_VERSION = 1;

/**
 * A local, in-memory store of ephemeral PRIVATE keys keyed by `handshakeId:role`.
 * Represents a device's transient secure storage during a handshake. It holds the
 * `KeyObject` only — never raw private bytes.
 */
export class EphemeralKeyStore {
  constructor({ clock } = {}) {
    this._clock = clock ?? (() => Date.now());
    /** @type {Map<string, { keyPair: object, keyId: string, createdAt: number, algorithm: string }>} */
    this._keys = new Map();
  }

  static _key(handshakeId, role) {
    return `${handshakeId}:${role}`;
  }

  /**
   * Generate + store a fresh ephemeral key pair for a (handshake, role).
   * @param {string} handshakeId @param {string} role
   * @param {{ identityPrivateKey?: import("crypto").KeyObject }} [options] optionally
   *   sign the ephemeral public key with the party's identity key (authenticated KE)
   * @returns {EphemeralPublicKeyBundle} the PUBLIC bundle to publish
   */
  generate(handshakeId, role, options = {}) {
    const keyPair = generateKeyPair();
    const keyId = crypto.randomUUID();
    const entry = { keyPair, keyId, createdAt: this._clock(), algorithm: KeyAgreementAlgorithm.X25519 };
    this._keys.set(EphemeralKeyStore._key(handshakeId, role), entry);
    return buildBundle(keyPair.publicKeyRaw, keyId, this._clock(), options);
  }

  /**
   * The stored private `KeyObject` for a (handshake, role).
   * @throws {EphemeralKeyNotFoundError}
   */
  privateKey(handshakeId, role) {
    const entry = this._keys.get(EphemeralKeyStore._key(handshakeId, role));
    if (!entry) {
      throw new EphemeralKeyNotFoundError("No local ephemeral key", { details: { handshakeId, role } });
    }
    return entry.keyPair.privateKey;
  }

  /** Whether an ephemeral key is held for a (handshake, role). */
  has(handshakeId, role) {
    return this._keys.has(EphemeralKeyStore._key(handshakeId, role));
  }

  /**
   * Destroy (drop) the ephemeral key for a (handshake, role). Returns whether one
   * existed. Idempotent.
   */
  destroy(handshakeId, role) {
    return this._keys.delete(EphemeralKeyStore._key(handshakeId, role));
  }

  /** Destroy every ephemeral key for a handshake (both roles). */
  destroyHandshake(handshakeId) {
    let removed = 0;
    for (const role of ["initiator", "responder"]) {
      if (this.destroy(handshakeId, role)) removed++;
    }
    return removed;
  }

  /** Number of ephemeral keys currently held. */
  get size() {
    return this._keys.size;
  }

  /** Drop every held ephemeral key (e.g. on shutdown). */
  clear() {
    this._keys.clear();
  }
}

/**
 * Build an {@link EphemeralPublicKeyBundle} from a raw public key.
 * @param {string} publicKeyRaw base64 raw X25519 public key
 * @param {string} keyId @param {number} nowMs
 * @param {{ identityPrivateKey?: import("crypto").KeyObject, identityPublicKey?: string }} [options]
 * @returns {EphemeralPublicKeyBundle}
 */
export function buildBundle(publicKeyRaw, keyId, nowMs, options = {}) {
  const bundle = {
    algorithm: KeyAgreementAlgorithm.X25519,
    publicKey: publicKeyRaw,
    keyId,
    version: EPHEMERAL_KEY_VERSION,
    createdAt: new Date(nowMs).toISOString(),
  };
  if (options.identityPrivateKey) {
    bundle.signature = signEphemeralKey(options.identityPrivateKey, publicKeyRaw);
    if (options.identityPublicKey) bundle.identityPublicKey = options.identityPublicKey;
  }
  return bundle;
}

/** Serialize an ephemeral public-key bundle to canonical JSON (PUBLIC data only). */
export function serializeBundle(bundle) {
  return JSON.stringify(bundle);
}

/** Parse an ephemeral public-key bundle from JSON. */
export function deserializeBundle(text) {
  return typeof text === "string" ? JSON.parse(text) : text;
}
