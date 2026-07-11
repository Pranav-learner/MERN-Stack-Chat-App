/**
 * @module data-plane/manager
 *
 * The **Reliable Messaging Engine** — the reusable facade for Layer 8, Sprint 1. It transports
 * ALREADY-ENCRYPTED application messages across the Active Connections Layer 7 established, with
 * guaranteed-delivery semantics: reliable delivery, per-conversation ordering, ACKs, retransmission,
 * and duplicate detection. One engine per device (its `deviceId`); it both SENDS (outbound) and
 * RECEIVES (inbound) over an INJECTED transport.
 *
 * @important This engine ONLY transports opaque ciphertext. It never encrypts, decrypts, or inspects
 * a payload (the crypto layer already produced the ciphertext), and it does not implement file
 * transfer, chunking, fragmentation, or media (Sprint 2). A FUTURE fragmentation sprint reuses this
 * engine.
 *
 * @security Records, wire envelopes, ACKs, DTOs, and events carry the OPAQUE `encryptedPayload` +
 * routing metadata only — never plaintext or key material. The no-plaintext invariant is enforced
 * before storage + before a wire envelope is built.
 *
 * @distributed The engine is stateless beyond its repository + in-memory indexes (queue, ordering,
 * dedupe cache), so it scales horizontally. Sequences come from an atomic repository counter;
 * retransmission is a stateless sweep; duplicate detection makes delivery at-most-once.
 *
 * @example
 * ```js
 * const engine = new MessagingEngine({ deviceId: "d1", ...createInMemoryMessageRepository(), transport });
 * const { message } = await engine.send({ conversationId: "c1", receiverDeviceId: "d2", encryptedPayload: ciphertext });
 * engine.onEvent("dataplane.message_acknowledged", (e) => markDelivered(e.messageId));
 * ```
 */

import crypto from "node:crypto";
import {
  DeliveryState,
  MessagingEventType,
  MessagingFailureReason,
  AckType,
  ReceiveOutcome,
  WireType,
  isActiveDeliveryState,
} from "../types/types.js";
import { DataPlaneError, NoConnectionError } from "../errors.js";
import { assertDeliveryTransition } from "../lifecycle/lifecycle.js";
import { createMessage, isMessageExpired } from "../delivery/message.js";
import { OrderingEngine } from "../ordering/ordering.js";
import { DuplicateCache } from "../delivery/dedupe.js";
import { MessageQueue } from "../queue/messageQueue.js";
import { buildDataEnvelope } from "../transport/wire.js";
import { buildAck, validateAckBlock, newAckId } from "../acknowledgement/ack.js";
import { computeBackoff, resolveRetryPolicy, shouldRetry } from "../retransmission/retransmission.js";
import { MessagingEventBus } from "../events/events.js";
import {
  validateSendRequest,
  validateWireEnvelope,
  validateMessageId,
  validateRef,
  requireMessage,
  assertSender,
  assertNoPlaintext,
  validateRepository,
} from "../validators/validators.js";
import { toPublicMessage, toDeliveryStatus, toMessageListItem } from "../serializers/serializer.js";

export class MessagingEngine {
  /**
   * @param {object} deps
   * @param {string} deps.deviceId this device's id (the sender/receiver identity)
   * @param {object} deps.messages message repository (required)
   * @param {object} [deps.inbound] inbound-message store @param {object} [deps.ackHistory] ack store @param {object} [deps.ordering] ordering-metadata store
   * @param {{ send: (envelope: object) => Promise<void> }} deps.transport injected transport (required)
   * @param {(receiverDeviceId: string) => (object|null)} [deps.connectionResolver] resolve a live connection to a peer
   * @param {MessagingEventBus} [deps.events] @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {object} [deps.retryPolicy] @param {object} [deps.orderingEngine] @param {object} [deps.duplicateCache] @param {object} [deps.queue]
   */
  constructor(deps) {
    if (!deps || !deps.deviceId) throw new Error("MessagingEngine requires { deviceId }");
    if (!deps.messages) throw new Error("MessagingEngine requires { messages }");
    if (!deps.transport || typeof deps.transport.send !== "function") throw new Error("MessagingEngine requires a transport with send()");
    this.deviceId = String(deps.deviceId);
    this.messages = validateRepository(deps.messages);
    this.inbound = deps.inbound ?? null;
    this.ackHistory = deps.ackHistory ?? null;
    this.orderingRepo = deps.ordering ?? null;
    this.transport = deps.transport;
    this.connectionResolver = deps.connectionResolver ?? null;
    this.events = deps.events ?? new MessagingEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.retryPolicy = resolveRetryPolicy(deps.retryPolicy);
    this.ordering = deps.orderingEngine ?? new OrderingEngine();
    this.dedupe = deps.duplicateCache ?? new DuplicateCache();
    this.queue = deps.queue ?? new MessageQueue();
    /** @type {Set<Function>} application delivery handlers (receive the opaque ciphertext, in order) */
    this._deliveryHandlers = new Set();
  }

  /** Subscribe to an engine event (or `"*"`). Events carry ids/states only. @returns {() => void} unsubscribe */
  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  /**
   * Register the APPLICATION delivery handler — invoked, in order, with each inbound message's OPAQUE
   * ciphertext so the app can decrypt it (the crypto layer's concern, not the data plane's). This is
   * the ONLY channel that carries the payload; the event bus stays metadata-only.
   * @param {(delivery: { messageId: string, conversationId: string, sender: string, seq: number, encryptedPayload: any }) => void} handler
   * @returns {() => void} unsubscribe
   */
  onMessage(handler) {
    this._deliveryHandlers.add(handler);
    return () => this._deliveryHandlers.delete(handler);
  }

  // === outbound ============================================================

  /**
   * Send an encrypted message: assign a sequence, queue it, and transmit over the peer's Active
   * Connection. Returns the message's delivery status DTO. @throws {MessageValidationError}
   *
   * @param {{ conversationId: string, receiverDeviceId: string, encryptedPayload: object, priority?: string, ttlMs?: number, connectionId?: string, actingDevice?: string }} request
   * @returns {Promise<{ message: object }>}
   */
  async send(request) {
    const req = { ...request, senderDeviceId: request.senderDeviceId ?? this.deviceId };
    validateSendRequest(req);
    if (request.actingDevice && String(request.actingDevice) !== this.deviceId) {
      throw new DataPlaneError("actingDevice must match the engine device", { code: "ERR_DATAPLANE_UNAUTHORIZED", status: 403 });
    }
    const seq = await this.messages.nextSequence(req.conversationId, this.deviceId);
    const connectionId = req.connectionId ?? this._resolveConnection(req.receiverDeviceId);
    const message = createMessage({ ...req, sequenceNumber: seq, connectionId, clock: this.clock, idGenerator: this.idGenerator });
    assertNoPlaintext(message, "message");
    let stored = await this.messages.create(message);
    stored = await this._transition(stored, DeliveryState.QUEUED, { event: MessagingEventType.MESSAGE_QUEUED });
    this.queue.enqueue(stored);
    stored = await this._transmit(stored);
    return { message: toPublicMessage(stored) };
  }

  // === inbound =============================================================

  /**
   * Receive a wire envelope (DATA or ACK) from the transport. DATA → dedup + order + deliver + ACK;
   * ACK → mark the outbound message acknowledged. @param {object} envelope @returns {Promise<object>}
   */
  async receive(envelope) {
    validateWireEnvelope(envelope);
    if (envelope.type === WireType.ACK) return this._handleAck(envelope);
    return this._handleData(envelope);
  }

  /** @private Handle an inbound DATA message: dedup → order → deliver → ACK. */
  async _handleData(envelope) {
    const conv = envelope.conversationId;
    // Duplicate detection: a re-transmitted message is re-ACKed but NOT re-delivered.
    if (this.dedupe.hasMessage(conv, envelope.messageId)) {
      this.events.emit(MessagingEventType.DUPLICATE_DETECTED, { messageId: envelope.messageId, conversationId: conv, reason: MessagingFailureReason.DUPLICATE_MESSAGE });
      await this._sendAck(envelope, AckType.DUPLICATE_ACK);
      return { outcome: ReceiveOutcome.DUPLICATE, delivered: 0 };
    }
    this.dedupe.addMessage(conv, envelope.messageId);

    // Ordering: deliver in-order runs, buffer gaps.
    const result = this.ordering.accept(conv, envelope.seq, envelope);
    for (const { message } of result.deliver) {
      if (this.inbound) await this.inbound.record({ messageId: message.messageId, conversationId: conv, senderDeviceId: message.sender, receiverDeviceId: message.receiver, encryptedPayload: message.payload, sequenceNumber: message.seq, receivedAt: this._nowIso(), deliveredAt: this._nowIso(), schemaVersion: 1 });
      // Hand the OPAQUE ciphertext to the application (the only channel that carries a payload).
      for (const handler of this._deliveryHandlers) {
        try {
          handler({ messageId: message.messageId, conversationId: conv, sender: message.sender, seq: message.seq, encryptedPayload: message.payload });
        } catch {
          // an application handler throwing must not break delivery/ordering
        }
      }
      this.events.emit(MessagingEventType.MESSAGE_DELIVERED, { messageId: message.messageId, conversationId: conv, sender: message.sender, seq: message.seq });
    }
    if (result.outcome === ReceiveOutcome.GAP) this.events.emit(MessagingEventType.ORDERING_GAP_DETECTED, { conversationId: conv, seq: envelope.seq, details: result.gap });
    if (result.recovered) this.events.emit(MessagingEventType.ORDERING_RECOVERED, { conversationId: conv, count: result.deliver.length });
    if (this.orderingRepo) await this.orderingRepo.saveMetadata(conv, this.ordering.snapshot(conv));

    // Always ACK a received (non-duplicate) message — its transmission succeeded regardless of order.
    await this._sendAck(envelope, AckType.ACK);
    return { outcome: result.outcome, delivered: result.deliver.length };
  }

  /** @private Handle an inbound ACK: mark the outbound message acknowledged (idempotent). */
  async _handleAck(envelope) {
    const ack = validateAckBlock(envelope.ack ?? {});
    if (ack.ackId && this.dedupe.hasAck(ack.ackId)) {
      this.events.emit(MessagingEventType.DUPLICATE_DETECTED, { messageId: ack.messageId, reason: "duplicate-ack" });
      return { outcome: ReceiveOutcome.DUPLICATE };
    }
    if (ack.ackId) this.dedupe.addAck(ack.ackId);
    if (this.ackHistory) await this.ackHistory.record({ ackId: ack.ackId, messageId: ack.messageId, conversationId: envelope.conversationId, ackType: ack.ackType, direction: "received", seq: ack.seq, at: this._nowIso(), schemaVersion: 1 });
    this.events.emit(MessagingEventType.ACK_RECEIVED, { messageId: ack.messageId, conversationId: envelope.conversationId });

    const message = await this.messages.findById(ack.messageId);
    if (!message || message.state === DeliveryState.ACKNOWLEDGED) return { outcome: ReceiveOutcome.DUPLICATE };
    if (!isActiveDeliveryState(message.state)) return { outcome: "ignored" };
    const acked = await this._transition(message, DeliveryState.ACKNOWLEDGED, {
      patch: { ackedAt: this._nowIso(), nextRetryAt: null },
      event: MessagingEventType.MESSAGE_ACKNOWLEDGED,
    });
    this.queue.remove(acked.messageId);
    return { outcome: "acknowledged", message: toPublicMessage(acked) };
  }

  /** @private Build + send an ACK for an inbound message; record + emit. */
  async _sendAck(inbound, ackType) {
    const ackId = newAckId();
    const ackEnvelope = buildAck(inbound, { ackType, ackId, ts: this._nowIso() });
    assertNoPlaintext(ackEnvelope, "ack");
    try {
      await this.transport.send(ackEnvelope);
      if (this.ackHistory) await this.ackHistory.record({ ackId, messageId: inbound.messageId, conversationId: inbound.conversationId, ackType, direction: "sent", seq: inbound.seq, at: this._nowIso(), schemaVersion: 1 });
      this.events.emit(MessagingEventType.ACK_SENT, { messageId: inbound.messageId, conversationId: inbound.conversationId, details: { ackType } });
    } catch {
      // The ACK couldn't be sent (link down) — the sender will retransmit + we'll re-ACK the duplicate.
    }
  }

  // === transmission + retransmission =======================================

  /** @private Attempt to transmit a queued message; requeue on no-connection. */
  async _transmit(message) {
    let msg = await this._transition(message, DeliveryState.SENDING, { event: MessagingEventType.MESSAGE_SENDING });
    const envelope = buildDataEnvelope(msg, { ts: this._nowIso() });
    try {
      await this.transport.send(envelope); // a fast/loopback peer may ACK during this await
      const current = await this.messages.findById(msg.messageId);
      if (current && current.state === DeliveryState.SENDING) {
        msg = await this._transition(current, DeliveryState.SENT, {
          patch: { sentAt: this._nowIso(), nextRetryAt: new Date(this.clock() + computeBackoff(current.retryCount, this.retryPolicy)).toISOString() },
          event: MessagingEventType.MESSAGE_SENT,
        });
      } else {
        msg = current ?? msg; // already delivered/acknowledged during the send
      }
      this.queue.remove(msg.messageId);
      return msg;
    } catch (error) {
      // No live connection → requeue for the retransmission sweep / reconnect flush.
      const current = await this.messages.findById(msg.messageId);
      if (current && current.state === DeliveryState.SENDING) {
        msg = await this._transition(current, DeliveryState.QUEUED, {
          reason: MessagingFailureReason.NO_CONNECTION,
          patch: { nextRetryAt: new Date(this.clock() + computeBackoff(current.retryCount, this.retryPolicy)).toISOString() },
        });
      }
      return msg;
    }
  }

  /**
   * Retransmission sweep: re-send messages past their ACK deadline; fail those out of retries; expire
   * those past TTL. Driven by the {@link module:data-plane/retransmission RetransmissionScheduler} in
   * production, or directly in tests. @param {number} [now] @returns {Promise<{ retried: number, failed: number, expired: number }>}
   */
  async sweepRetries(now = this.clock()) {
    const nowIso = new Date(now).toISOString();
    const due = await this.messages.listRetryDue(nowIso);
    let retried = 0;
    let failed = 0;
    let expired = 0;
    for (const message of due) {
      try {
        if (isMessageExpired(message, now)) {
          await this._transition(message, DeliveryState.EXPIRED, { reason: MessagingFailureReason.EXPIRED_MESSAGE, patch: { nextRetryAt: null }, event: MessagingEventType.MESSAGE_EXPIRED });
          this.queue.remove(message.messageId);
          expired++;
          continue;
        }
        if (!shouldRetry(message.retryCount, this.retryPolicy)) {
          await this._transition(message, DeliveryState.FAILED, { reason: MessagingFailureReason.RETRY_EXHAUSTED, patch: { nextRetryAt: null }, event: MessagingEventType.MESSAGE_FAILED });
          this.events.emit(MessagingEventType.RETRY_FAILED, { messageId: message.messageId, retryCount: message.retryCount });
          this.queue.remove(message.messageId);
          failed++;
          continue;
        }
        // Retransmit the SAME opaque envelope (duplicate delivery is prevented by the receiver's cache).
        const bumped = await this.messages.update(message.messageId, { retryCount: (message.retryCount ?? 0) + 1 });
        this.events.emit(MessagingEventType.RETRY_SCHEDULED, { messageId: bumped.messageId, retryCount: bumped.retryCount });
        const before = bumped.retryCount;
        const sent = await this._retransmit(bumped);
        if (sent.state === DeliveryState.SENT || sent.state === DeliveryState.ACKNOWLEDGED) this.events.emit(MessagingEventType.RETRY_SUCCEEDED, { messageId: sent.messageId, retryCount: before });
        retried++;
      } catch {
        // concurrent transition / terminal; skip
      }
    }
    return { retried, failed, expired };
  }

  /** @private Retransmit a message: SENT → SENDING → SENT (or requeue). */
  async _retransmit(message) {
    let msg = message;
    if (message.state === DeliveryState.SENT) {
      msg = await this._transition(message, DeliveryState.SENDING, {});
    } else if (message.state === DeliveryState.QUEUED) {
      msg = await this._transition(message, DeliveryState.SENDING, {});
    } else {
      return message;
    }
    const envelope = buildDataEnvelope(msg, { ts: this._nowIso() });
    try {
      await this.transport.send(envelope);
      const current = await this.messages.findById(msg.messageId);
      if (current && current.state === DeliveryState.SENDING) {
        return this._transition(current, DeliveryState.SENT, { patch: { sentAt: this._nowIso(), nextRetryAt: new Date(this.clock() + computeBackoff(current.retryCount, this.retryPolicy)).toISOString() } });
      }
      return current ?? msg;
    } catch {
      const current = await this.messages.findById(msg.messageId);
      if (current && current.state === DeliveryState.SENDING) return this._transition(current, DeliveryState.QUEUED, { patch: { nextRetryAt: new Date(this.clock() + computeBackoff(current.retryCount, this.retryPolicy)).toISOString() } });
      return current ?? msg;
    }
  }

  /**
   * Flush pending (queued / sent-unacked) messages — call after a reconnect so buffered messages are
   * re-transmitted over the restored connection. @param {string} [connectionId]
   * @returns {Promise<{ flushed: number }>}
   */
  async flushPending(connectionId) {
    const pending = await this.messages.listPendingByConnection(connectionId);
    let flushed = 0;
    for (const message of pending) {
      if (message.state === DeliveryState.QUEUED || message.state === DeliveryState.SENT) {
        await this._retransmit(message);
        flushed++;
      }
    }
    return { flushed };
  }

  // === lifecycle actions ===================================================

  /** Cancel an active outbound message (before delivery). */
  async cancel(messageId, options = {}) {
    const message = await this._require(messageId);
    if (options.actingDevice) assertSender(message, options.actingDevice);
    if (!isActiveDeliveryState(message.state)) {
      throw new DataPlaneError(`Cannot cancel a message in state "${message.state}"`, { code: "ERR_DATAPLANE_INVALID_TRANSITION", status: 409 });
    }
    const cancelled = await this._transition(message, DeliveryState.CANCELLED, { reason: "cancelled", patch: { nextRetryAt: null } });
    this.queue.remove(messageId);
    return toPublicMessage(cancelled);
  }

  /** Sweep expired active messages → EXPIRED. */
  async sweepExpired(now = this.clock()) {
    const stale = await this.messages.listExpired(new Date(now).toISOString());
    let expired = 0;
    for (const message of stale) {
      try {
        await this._transition(message, DeliveryState.EXPIRED, { reason: MessagingFailureReason.EXPIRED_MESSAGE, patch: { nextRetryAt: null }, event: MessagingEventType.MESSAGE_EXPIRED });
        this.queue.remove(message.messageId);
        expired++;
      } catch {
        // skip
      }
    }
    return { expired };
  }

  // === queries =============================================================

  /** A message's public DTO (delivery metadata; no payload unless requested). */
  async getMessage(messageId, options = {}) {
    const message = await this._require(messageId);
    if (options.actingDevice) assertSender(message, options.actingDevice);
    return toPublicMessage(message, { includePayload: options.includePayload });
  }

  /** A message's compact delivery status. */
  async getStatus(messageId) {
    return toDeliveryStatus(await this._require(messageId));
  }

  /** Pending (in-flight) messages, optionally for one connection. */
  async getPending(connectionId) {
    return (await this.messages.listPendingByConnection(connectionId)).map(toMessageListItem);
  }

  /** Delivery history for a conversation. */
  async getHistory(conversationId, options = {}) {
    validateRef(conversationId, "conversation identifier");
    return (await this.messages.listByConversation(String(conversationId), { limit: options.limit })).map(toMessageListItem);
  }

  /** Diagnostics for a conversation (queue depth, ordering, counts, ack history). */
  async getDiagnostics(conversationId, options = {}) {
    validateRef(conversationId, "conversation identifier");
    const cid = String(conversationId);
    return {
      conversationId: cid,
      queueDepth: this.queue.size,
      queueByPriority: this.queue.depthByPriority(),
      ordering: this.ordering.snapshot(cid),
      countsByState: await this.messages.countByState(),
      recentAcks: this.ackHistory ? await this.ackHistory.listByConversation(cid, { limit: options.limit ?? 20 }) : [],
    };
  }

  // === internals ==========================================================

  /** @private Load + require a message (validated). */
  async _require(messageId) {
    validateMessageId(messageId);
    return requireMessage(await this.messages.findById(messageId), messageId);
  }

  /** @private Resolve a live connection id to a receiver (via the injected resolver). */
  _resolveConnection(receiverDeviceId) {
    if (!this.connectionResolver) return null;
    const conn = this.connectionResolver(receiverDeviceId);
    return conn && conn.live !== false ? conn.connectionId ?? null : null;
  }

  /** @private Guarded delivery-state transition + persist + emit. */
  async _transition(message, toState, options = {}) {
    assertDeliveryTransition(message.state, toState);
    const at = this._nowIso();
    const patch = { state: toState, version: (message.version ?? 0) + 1, updatedAt: at, ...(options.patch ?? {}) };
    if (options.patch) assertNoPlaintext(patch, "message");
    const updated = await this.messages.update(message.messageId, patch);
    if (options.event) {
      this.events.emit(options.event, { messageId: updated.messageId, conversationId: updated.conversationId, sender: updated.senderDeviceId, receiver: updated.receiverDeviceId, seq: updated.sequenceNumber, state: toState, previousState: message.state, reason: options.reason, retryCount: updated.retryCount });
    }
    return updated;
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}
