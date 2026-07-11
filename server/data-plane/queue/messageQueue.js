/**
 * @module data-plane/queue
 *
 * The **Message Queue** — an in-memory priority queue of messages awaiting transmission (no live
 * connection yet, or awaiting the engine to flush them). Higher-priority messages dequeue first; ties
 * break by enqueue order (FIFO) so a conversation's messages keep their relative order. Backed by a
 * Map so a message can be removed by id (e.g. cancelled) in O(1)-ish.
 *
 * @security The queue holds message RECORDS (opaque ciphertext) — it never inspects payloads. It also
 * rejects DUPLICATE queue entries (same messageId).
 *
 * @distributed Process-local here; a distributed deployment can back this with a durable queue behind
 * the same `enqueue` / `dequeue` interface. Messages are ALSO persisted in the repository, so the
 * queue is a fast index, not the source of truth.
 */

import { PRIORITY_WEIGHT, MessagePriority } from "../types/types.js";

export class MessageQueue {
  constructor() {
    /** @type {Map<string, { message: object, seq: number }>} messageId -> entry */
    this._entries = new Map();
    this._counter = 0;
  }

  /** Enqueue a message. Idempotent — a duplicate messageId is ignored. @returns {boolean} whether it was added */
  enqueue(message) {
    if (this._entries.has(message.messageId)) return false;
    this._entries.set(message.messageId, { message, seq: this._counter++ });
    return true;
  }

  /** Whether a message id is queued. */
  has(messageId) {
    return this._entries.has(messageId);
  }

  /** Remove a message by id (e.g. cancelled / sent). @returns {boolean} */
  remove(messageId) {
    return this._entries.delete(messageId);
  }

  /** Peek the next message to send (highest priority, then FIFO) without removing it. */
  peek() {
    let best = null;
    for (const entry of this._entries.values()) {
      if (!best || this._before(entry, best)) best = entry;
    }
    return best?.message ?? null;
  }

  /** Dequeue the next message to send. @returns {object|null} */
  dequeue() {
    const next = this.peek();
    if (next) this._entries.delete(next.messageId);
    return next;
  }

  /**
   * Drain up to `max` messages in send order (highest priority first). Removes them from the queue.
   * @param {number} [max] @returns {object[]}
   */
  drain(max = Infinity) {
    const out = [];
    while (out.length < max) {
      const m = this.dequeue();
      if (!m) break;
      out.push(m);
    }
    return out;
  }

  /** Current queue depth. */
  get size() {
    return this._entries.size;
  }

  /** Queue depth by priority (observability). */
  depthByPriority() {
    const depth = { [MessagePriority.HIGH]: 0, [MessagePriority.NORMAL]: 0, [MessagePriority.LOW]: 0 };
    for (const { message } of this._entries.values()) depth[message.priority ?? MessagePriority.NORMAL]++;
    return depth;
  }

  /** Clear the queue. */
  clear() {
    this._entries.clear();
  }

  /** @private Whether entry `a` should send before entry `b`. */
  _before(a, b) {
    const wa = PRIORITY_WEIGHT[a.message.priority] ?? 1;
    const wb = PRIORITY_WEIGHT[b.message.priority] ?? 1;
    if (wa !== wb) return wa > wb; // higher priority first
    return a.seq < b.seq; // then FIFO
  }
}
