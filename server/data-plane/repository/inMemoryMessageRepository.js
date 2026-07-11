/**
 * @module data-plane/repository/inMemory
 *
 * In-memory data-plane repositories: the reference for the store contracts + the test/device backend.
 * Bundles four stores:
 *
 * - `messages`  — OUTBOUND message records (the sender's delivery state machine).
 * - `inbound`   — INBOUND delivered messages (for duplicate history + audit).
 * - `ackHistory`— acknowledgements sent/received.
 * - `ordering`  — per-conversation ordering metadata (expected sequence) for recovery.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 * The queue is a fast in-memory index; the repository is the durable source of truth.
 *
 * ## Message store contract (shared with Mongo)
 * - `create(m) -> m` · `findById(id) -> m | null` · `update(id, patch) -> m` · `delete(id) -> boolean`
 * - `listPendingByConnection(connectionId) -> m[]` · `listRetryDue(nowIso) -> m[]` · `listExpired(nowIso) -> m[]`
 * - `listByConversation(conversationId, { limit }) -> m[]` · `countByState() -> {}` · `nextSequence(conversationId, senderDeviceId) -> number`
 */

import { MessageNotFoundError } from "../errors.js";
import { ACTIVE_DELIVERY_STATES, DeliveryState } from "../types/types.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const ACTIVE = new Set(ACTIVE_DELIVERY_STATES);
// States a retry sweep should consider (sent-but-unacked).
const RETRYABLE = new Set([DeliveryState.SENT, DeliveryState.QUEUED, DeliveryState.SENDING]);

/** @returns {{ messages: object, inbound: object, ackHistory: object, ordering: object, reset: () => void }} */
export function createInMemoryMessageRepository() {
  /** @type {Map<string, object>} messageId -> outbound message */
  const byId = new Map();
  /** @type {Map<string, object>} messageId -> inbound message */
  const inboundById = new Map();
  /** @type {object[]} ack history */
  const ackLog = [];
  /** @type {Map<string, object>} conversationId -> ordering metadata */
  const orderingByConv = new Map();
  /** @type {Map<string, number>} `${conversationId}|${senderDeviceId}` -> last seq */
  const seqByStream = new Map();

  const messages = {
    async create(m) {
      byId.set(m.messageId, clone(m));
      return clone(m);
    },
    async findById(messageId) {
      const m = byId.get(String(messageId));
      return m ? clone(m) : null;
    },
    async update(messageId, patch) {
      const key = String(messageId);
      const existing = byId.get(key);
      if (!existing) throw new MessageNotFoundError("Message not found", { details: { messageId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(key, clone(updated));
      return clone(updated);
    },
    async delete(messageId) {
      return byId.delete(String(messageId));
    },
    async listPendingByConnection(connectionId) {
      const cid = connectionId != null ? String(connectionId) : null;
      return [...byId.values()]
        .filter((m) => ACTIVE.has(m.state) && (cid === null || m.connectionId === cid))
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
        .map(clone);
    },
    async listRetryDue(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...byId.values()]
        .filter((m) => RETRYABLE.has(m.state) && m.nextRetryAt && new Date(m.nextRetryAt).getTime() <= now)
        .map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...byId.values()]
        .filter((m) => ACTIVE.has(m.state) && m.expiresAt && new Date(m.expiresAt).getTime() <= now)
        .map(clone);
    },
    async listByConversation(conversationId, options = {}) {
      const cid = String(conversationId);
      const list = [...byId.values()].filter((m) => m.conversationId === cid).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      return (options.limit ? list.slice(-options.limit) : list).map(clone);
    },
    async countByState() {
      const counts = {};
      for (const m of byId.values()) counts[m.state] = (counts[m.state] ?? 0) + 1;
      return counts;
    },
    async nextSequence(conversationId, senderDeviceId) {
      const key = `${conversationId}|${senderDeviceId}`;
      const next = (seqByStream.get(key) ?? 0) + 1;
      seqByStream.set(key, next);
      return next;
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  const inbound = {
    async record(m) {
      inboundById.set(m.messageId, clone(m));
      return clone(m);
    },
    async findById(messageId) {
      const m = inboundById.get(String(messageId));
      return m ? clone(m) : null;
    },
    async listByConversation(conversationId, options = {}) {
      const cid = String(conversationId);
      const list = [...inboundById.values()].filter((m) => m.conversationId === cid).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      return (options.limit ? list.slice(-options.limit) : list).map(clone);
    },
  };

  const ackHistory = {
    async record(ack) {
      ackLog.push(clone(ack));
      return clone(ack);
    },
    async listByMessage(messageId) {
      return ackLog.filter((a) => a.messageId === String(messageId)).map(clone);
    },
    async listByConversation(conversationId, options = {}) {
      const list = ackLog.filter((a) => a.conversationId === String(conversationId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  const ordering = {
    async getMetadata(conversationId) {
      const o = orderingByConv.get(String(conversationId));
      return o ? clone(o) : null;
    },
    async saveMetadata(conversationId, metadata) {
      orderingByConv.set(String(conversationId), clone({ conversationId: String(conversationId), ...metadata }));
      return clone(orderingByConv.get(String(conversationId)));
    },
  };

  return {
    messages,
    inbound,
    ackHistory,
    ordering,
    reset: () => {
      byId.clear();
      inboundById.clear();
      ackLog.length = 0;
      orderingByConv.clear();
      seqByStream.clear();
    },
  };
}
