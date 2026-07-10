/**
 * @module shs/session/storage
 *
 * Device-local secure storage for session key material. This is the ONLY place raw
 * session keys (encryption / MAC / init / ratchet / resumption) and the originating
 * shared secret live. Keyed by `sessionId`.
 *
 * @security Nothing here is ever serialized, persisted to the server, or returned by
 * an API — the {@link module:shs/session/serialization} layer + repositories only ever
 * see session METADATA. `destroy()` zero-fills the secret buffers before dropping
 * them (JS cannot force-wipe a value, but transient `Buffer`s are cleared).
 */

import { disposeSessionKeys } from "../derivation/sessionKeys.js";

/**
 * In-memory secure key store. Represents a device's transient key vault. Not
 * persisted; construct one per device/process.
 */
export class SecureKeyStore {
  constructor() {
    /** @type {Map<string, { keys: object, sharedSecret: Buffer }>} */
    this._vault = new Map();
  }

  /**
   * Store a session's derived keys + originating shared secret (for future rekeys).
   * @param {string} sessionId
   * @param {object} keys a {@link SessionKeys} bundle
   * @param {Buffer} sharedSecret a COPY is retained device-locally for rekeying
   */
  store(sessionId, keys, sharedSecret) {
    this._vault.set(String(sessionId), {
      keys,
      sharedSecret: Buffer.isBuffer(sharedSecret) ? Buffer.from(sharedSecret) : null,
    });
  }

  /** Whether keys are held for a session. */
  has(sessionId) {
    return this._vault.has(String(sessionId));
  }

  /** The stored {@link SessionKeys} for a session (device-local use only). */
  getKeys(sessionId) {
    return this._vault.get(String(sessionId))?.keys ?? null;
  }

  /** The stored shared secret for a session (device-local; for rekeying). */
  getSharedSecret(sessionId) {
    return this._vault.get(String(sessionId))?.sharedSecret ?? null;
  }

  /** Replace a session's derived keys (e.g. after a rekey), disposing the old ones. */
  replaceKeys(sessionId, keys) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) return false;
    disposeSessionKeys(entry.keys);
    entry.keys = keys;
    return true;
  }

  /** Destroy (zero-fill + drop) a session's key material. Idempotent. */
  destroy(sessionId) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) return false;
    disposeSessionKeys(entry.keys);
    if (Buffer.isBuffer(entry.sharedSecret)) entry.sharedSecret.fill(0);
    this._vault.delete(String(sessionId));
    return true;
  }

  /** Number of sessions with stored keys. */
  get size() {
    return this._vault.size;
  }

  /** Destroy all key material (e.g. on logout). */
  destroyAll() {
    for (const id of [...this._vault.keys()]) this.destroy(id);
  }
}
