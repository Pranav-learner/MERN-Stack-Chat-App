/**
 * @module data-plane/delivery/dedupe
 *
 * **Duplicate detection.** A bounded, per-conversation cache of seen message ids (and ACK ids) that
 * guarantees *at-most-once delivery to the application*: a re-transmitted or re-ordered message whose
 * id was already delivered is recognized as a duplicate and re-ACKed (not re-delivered). Also detects
 * duplicate ACKs on the sender side.
 *
 * @security The cache holds ids only — no ciphertext, no plaintext, no keys.
 *
 * @evolution `checkReplay` is an inert PLACEHOLDER here: cryptographic replay resistance already lives
 * in Layer 5 (per-message keys + replay windows). This is the data-plane transport-level duplicate
 * guard, distinct from crypto replay.
 */

import { DEFAULT_DEDUPE_CACHE_SIZE } from "../types/types.js";

/** A bounded LRU set (insertion-ordered Map used as a set). */
class LruSet {
  constructor(limit) {
    this._limit = limit;
    this._m = new Map();
  }
  has(id) {
    return this._m.has(id);
  }
  add(id) {
    if (this._m.has(id)) {
      this._m.delete(id);
      this._m.set(id, 1);
      return false; // was already present
    }
    this._m.set(id, 1);
    while (this._m.size > this._limit) this._m.delete(this._m.keys().next().value);
    return true; // newly added
  }
  get size() {
    return this._m.size;
  }
  clear() {
    this._m.clear();
  }
}

/**
 * Per-conversation duplicate-detection cache for inbound messages + inbound ACKs.
 */
export class DuplicateCache {
  /** @param {{ size?: number }} [options] */
  constructor(options = {}) {
    this._size = options.size ?? DEFAULT_DEDUPE_CACHE_SIZE;
    /** @type {Map<string, LruSet>} conversationId -> seen message ids */
    this._messages = new Map();
    /** @type {LruSet} seen ACK ids (sender side) */
    this._acks = new LruSet(this._size);
  }

  /** Whether a message id has already been seen for a conversation. */
  hasMessage(conversationId, messageId) {
    return this._forConv(conversationId).has(messageId);
  }

  /**
   * Record a message id as seen. @returns {boolean} `true` if newly seen, `false` if it was a duplicate.
   */
  addMessage(conversationId, messageId) {
    return this._forConv(conversationId).add(messageId);
  }

  /** Whether an ACK id has already been processed (sender-side duplicate-ACK detection). */
  hasAck(ackId) {
    return this._acks.has(ackId);
  }

  /** Record an ACK id. @returns {boolean} `true` if newly seen. */
  addAck(ackId) {
    return this._acks.add(ackId);
  }

  /**
   * FUTURE placeholder — transport-level replay detection. Inert here: cryptographic replay resistance
   * is Layer 5's job (per-message keys + replay windows). @returns {boolean} always `false` (not a replay)
   */
  checkReplay() {
    return false;
  }

  /** Drop a conversation's seen-message cache (e.g. on conversation close). */
  reset(conversationId) {
    this._messages.delete(conversationId);
  }

  /** @private */
  _forConv(conversationId) {
    let set = this._messages.get(conversationId);
    if (!set) {
      set = new LruSet(this._size);
      this._messages.set(conversationId, set);
    }
    return set;
  }
}
