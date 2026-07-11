/**
 * @module transport-engine/multiplexing
 *
 * **Logical transport multiplexing.** A single Active Connection carries MANY concurrent transfers as
 * independent logical streams. The multiplexer registers each active transfer as a stream, keeps
 * per-stream metadata (priority, conversation, progress), isolates streams by conversation, and
 * provides a round-robin ordering so equal-priority streams share the link fairly.
 *
 * @evolution A future media sprint (Layer 11) registers a media stream the same way — the `stream`
 * metadata slot is the seam. This subsystem does NOT open sockets; it is the logical stream registry
 * over whatever transport is injected.
 */

export class Multiplexer {
  /** @param {object} [options] @param {number} [options.maxConcurrent] */
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent ?? Infinity;
    /** @type {Map<string, object>} transferId -> stream metadata */
    this._streams = new Map();
    /** @type {string[]} round-robin order of transferIds */
    this._order = [];
    this._cursor = 0;
  }

  /** Whether another stream can be registered (concurrency cap). */
  get hasCapacity() {
    return this._streams.size < this.maxConcurrent;
  }
  get activeCount() {
    return this._streams.size;
  }

  /** Register (or update) a stream for a transfer. */
  register(transferId, meta = {}) {
    const id = String(transferId);
    if (!this._streams.has(id)) this._order.push(id);
    this._streams.set(id, { transferId: id, conversationId: meta.conversationId, priority: meta.priority, direction: meta.direction, registeredAt: meta.registeredAt ?? null, ...meta });
    return this._streams.get(id);
  }

  /** Remove a stream (transfer completed / cancelled). */
  unregister(transferId) {
    const id = String(transferId);
    const removed = this._streams.delete(id);
    const idx = this._order.indexOf(id);
    if (idx >= 0) {
      this._order.splice(idx, 1);
      if (this._cursor > idx) this._cursor--;
    }
    if (this._order.length) this._cursor %= this._order.length;
    else this._cursor = 0;
    return removed;
  }

  has(transferId) {
    return this._streams.has(String(transferId));
  }
  get(transferId) {
    return this._streams.get(String(transferId));
  }

  /** All streams. */
  streams() {
    return [...this._streams.values()];
  }

  /** Streams for one conversation (isolation). */
  streamsForConversation(conversationId) {
    return this.streams().filter((s) => s.conversationId === conversationId);
  }

  /**
   * The stream ids in fair round-robin order starting AFTER the last-served cursor, so repeated calls
   * rotate which equal-priority stream is considered first. Advances the cursor by one.
   * @returns {string[]}
   */
  rotation() {
    if (this._order.length === 0) return [];
    const out = [];
    for (let i = 0; i < this._order.length; i++) out.push(this._order[(this._cursor + i) % this._order.length]);
    this._cursor = (this._cursor + 1) % this._order.length;
    return out;
  }

  snapshot() {
    return { activeCount: this._streams.size, maxConcurrent: this.maxConcurrent, streams: this.streams().map((s) => ({ transferId: s.transferId, conversationId: s.conversationId, priority: s.priority, direction: s.direction })) };
  }
}
