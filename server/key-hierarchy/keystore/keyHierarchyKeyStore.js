/**
 * @module key-hierarchy/keystore
 *
 * Device-local secure store for the hierarchy's SECRET material — the Session Root Key and
 * the sending / receiving chain keys. Keyed by `sessionId`. This is the ONLY place these
 * bytes live.
 *
 * @security Nothing here is ever serialized, persisted, logged, or returned by an API. The
 * repository + DTOs only ever see METADATA. Every mutation that drops a secret zero-fills it
 * first. Advancing a chain disposes the previous chain key (one-way ratchet); re-rooting
 * disposes the old root + both old chain keys. Construct one store per device/process.
 */

import { advanceChainKey, disposeKey } from "../derivation/derivation.js";

export class KeyHierarchyKeyStore {
  constructor() {
    /** @type {Map<string, { rootKey: Buffer, sending: { key: Buffer, index: number }, receiving: { key: Buffer, index: number }, context: object }>} */
    this._vault = new Map();
  }

  /**
   * Initialise a session's hierarchy: store the root key + both initial chain keys.
   * Overwrites + wipes any prior state.
   * @param {string} sessionId @param {Buffer} rootKey @param {Buffer} sendingKey @param {Buffer} receivingKey @param {object} context
   */
  initialize(sessionId, rootKey, sendingKey, receivingKey, context) {
    this.destroySession(sessionId);
    this._vault.set(String(sessionId), {
      rootKey,
      sending: { key: sendingKey, index: 0 },
      receiving: { key: receivingKey, index: 0 },
      context,
    });
  }

  /** Whether a session is initialised. */
  has(sessionId) {
    return this._vault.has(String(sessionId));
  }

  /** The device-local derivation context, or null. */
  getContext(sessionId) {
    return this._vault.get(String(sessionId))?.context ?? null;
  }

  /** The root key (device-local), or null. */
  getRootKey(sessionId) {
    return this._vault.get(String(sessionId))?.rootKey ?? null;
  }

  /** The current sending chain key (device-local), or null. */
  getSendingKey(sessionId) {
    return this._vault.get(String(sessionId))?.sending.key ?? null;
  }

  /** The current receiving chain key (device-local), or null. */
  getReceivingKey(sessionId) {
    return this._vault.get(String(sessionId))?.receiving.key ?? null;
  }

  /** The current sending chain index, or -1. */
  sendingIndex(sessionId) {
    return this._vault.get(String(sessionId))?.sending.index ?? -1;
  }

  /** The current receiving chain index, or -1. */
  receivingIndex(sessionId) {
    return this._vault.get(String(sessionId))?.receiving.index ?? -1;
  }

  /**
   * Advance the sending chain: ratchet its key forward, disposing the previous key.
   * @param {string} sessionId @returns {{ key: Buffer, index: number }} the NEW chain key + index
   */
  advanceSending(sessionId) {
    return this._advance(sessionId, "sending");
  }

  /**
   * Advance the receiving chain: ratchet its key forward, disposing the previous key.
   * @param {string} sessionId @returns {{ key: Buffer, index: number }}
   */
  advanceReceiving(sessionId) {
    return this._advance(sessionId, "receiving");
  }

  /**
   * Re-root the hierarchy at a new generation: install a fresh root + chain keys, disposing
   * the previous root + both previous chain keys (forward secrecy across generations).
   * @param {string} sessionId @param {Buffer} rootKey @param {Buffer} sendingKey @param {Buffer} receivingKey
   */
  reroot(sessionId, rootKey, sendingKey, receivingKey) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) throw new Error("Cannot re-root an uninitialised session");
    disposeKey(entry.rootKey);
    disposeKey(entry.sending.key);
    disposeKey(entry.receiving.key);
    entry.rootKey = rootKey;
    entry.sending = { key: sendingKey, index: 0 };
    entry.receiving = { key: receivingKey, index: 0 };
  }

  /** Securely destroy ALL of a session's key material. Idempotent. @returns {boolean} */
  destroySession(sessionId) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) return false;
    disposeKey(entry.rootKey);
    disposeKey(entry.sending.key);
    disposeKey(entry.receiving.key);
    this._vault.delete(String(sessionId));
    return true;
  }

  /** Number of sessions with key material held. */
  get size() {
    return this._vault.size;
  }

  /** Destroy all key material (e.g. on logout). */
  destroyAll() {
    for (const id of [...this._vault.keys()]) this.destroySession(id);
  }

  /** @private Ratchet one direction forward, disposing the old key. */
  _advance(sessionId, which) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) throw new Error("Cannot advance an uninitialised session");
    const slot = entry[which];
    const nextIndex = slot.index + 1;
    const nextKey = advanceChainKey(slot.key, entry.context.chainContext, nextIndex);
    disposeKey(slot.key);
    slot.key = nextKey;
    slot.index = nextIndex;
    return { key: nextKey, index: nextIndex };
  }
}
