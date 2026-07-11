/**
 * @module data-plane/ordering
 *
 * The **Ordering Engine** — enforces in-order delivery per conversation using sequence numbers.
 * Inbound messages that arrive out of order are held in a per-conversation reorder buffer until the
 * gap fills; contiguous runs are then delivered in order. Detects gaps + recovers when a gap can't
 * fill (buffer cap) by force-advancing past the missing sequence.
 *
 * @important This sprint orders whole MESSAGES by sequence number. Fragment ordering (reassembling a
 * chunked payload) is a FUTURE sprint — the buffer/gap machinery here is the seam it reuses.
 *
 * @security Ordering operates on sequence numbers + opaque envelopes — it never inspects ciphertext.
 */

import { ReceiveOutcome, DEFAULT_REORDER_BUFFER_LIMIT } from "../types/types.js";

export class OrderingEngine {
  /** @param {{ bufferLimit?: number }} [options] */
  constructor(options = {}) {
    this.bufferLimit = options.bufferLimit ?? DEFAULT_REORDER_BUFFER_LIMIT;
    /** @type {Map<string, { expected: number, buffer: Map<number, any> }>} */
    this._state = new Map();
  }

  /** Seed a conversation's expected sequence (e.g. from persisted ordering metadata). */
  seed(conversationId, expected) {
    const s = this._get(conversationId);
    s.expected = Math.max(s.expected, expected ?? 1);
  }

  /** The next expected sequence for a conversation. */
  expected(conversationId) {
    return this._get(conversationId).expected;
  }

  /** The current reorder-buffer size for a conversation. */
  bufferSize(conversationId) {
    return this._get(conversationId).buffer.size;
  }

  /**
   * Accept an inbound message at `seq`. Returns what to deliver (in order) + the classification.
   *
   * @param {string} conversationId @param {number} seq @param {any} message the inbound envelope/record
   * @returns {{ outcome: string, deliver: Array<{ seq: number, message: any }>, gap: { from: number, to: number }|null, recovered: boolean }}
   */
  accept(conversationId, seq, message) {
    const s = this._get(conversationId);

    if (seq < s.expected) {
      // Already delivered (or skipped) → a duplicate/old message.
      return { outcome: ReceiveOutcome.DUPLICATE, deliver: [], gap: null, recovered: false };
    }

    if (seq === s.expected) {
      const deliver = [{ seq, message }];
      s.expected += 1;
      // Drain any now-contiguous buffered messages.
      while (s.buffer.has(s.expected)) {
        deliver.push({ seq: s.expected, message: s.buffer.get(s.expected) });
        s.buffer.delete(s.expected);
        s.expected += 1;
      }
      const recovered = deliver.length > 1;
      return { outcome: ReceiveOutcome.DELIVERED, deliver, gap: null, recovered };
    }

    // seq > expected → a gap. Buffer it.
    const gap = { from: s.expected, to: seq - 1 };
    if (!s.buffer.has(seq)) s.buffer.set(seq, message);

    // If the buffer is over the cap, the missing sequence is presumed lost → force-recover past it.
    if (s.buffer.size > this.bufferLimit) {
      return this._forceRecover(conversationId, s);
    }
    return { outcome: ReceiveOutcome.GAP, deliver: [], gap, recovered: false };
  }

  /** Reset a conversation's ordering state (e.g. on conversation close). */
  reset(conversationId) {
    this._state.delete(conversationId);
  }

  /** A snapshot of a conversation's ordering metadata (for persistence). */
  snapshot(conversationId) {
    const s = this._get(conversationId);
    return { conversationId, expected: s.expected, buffered: [...s.buffer.keys()].sort((a, b) => a - b) };
  }

  /** @private */
  _get(conversationId) {
    let s = this._state.get(conversationId);
    if (!s) {
      s = { expected: 1, buffer: new Map() };
      this._state.set(conversationId, s);
    }
    return s;
  }

  /** @private Advance past a permanently-missing sequence, delivering the earliest buffered run. */
  _forceRecover(conversationId, s) {
    const lowest = Math.min(...s.buffer.keys());
    s.expected = lowest; // skip the gap up to the earliest buffered message
    const deliver = [];
    while (s.buffer.has(s.expected)) {
      deliver.push({ seq: s.expected, message: s.buffer.get(s.expected) });
      s.buffer.delete(s.expected);
      s.expected += 1;
    }
    return { outcome: ReceiveOutcome.DELIVERED, deliver, gap: null, recovered: true };
  }
}
