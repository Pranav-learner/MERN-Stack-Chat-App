/**
 * @module data-plane/api/relay
 *
 * The server-side **blind relay** for the data plane. Where the {@link MessagingEngine} runs on a
 * DEVICE (peer-to-peer, sender-centric), the relay runs on the SERVER: it accepts an already-encrypted
 * message from a sender device, persists the OPAQUE ciphertext + delivery metadata, lets the receiver
 * device pull it (store-and-forward), and records the receiver's ACK. It reuses the data-plane
 * repository, validators, and serializers.
 *
 * @security The relay is BLIND — it never decrypts, inspects, or holds key material. It validates the
 * no-plaintext invariant before persisting and returns metadata DTOs (ciphertext only on an explicit
 * inbox pull, so the receiver can decrypt it). Ownership is enforced: only the sender reads its own
 * outbound status; only the receiver pulls + ACKs its inbox.
 *
 * @note This is the coordination path for deployments without a live Layer-7 P2P link (store-and-
 * forward). When devices hold a direct Active Connection, they run the engine peer-to-peer and the
 * relay is bypassed. Both share the same wire model + repository, so delivery tracking is uniform.
 */

import { createMessage } from "../delivery/message.js";
import { validateSendRequest, validateRef, validateMessageId, requireMessage, assertNoPlaintext, assertSender } from "../validators/validators.js";
import { toPublicMessage, toDeliveryStatus, toMessageListItem } from "../serializers/serializer.js";
import { MessagingEventBus } from "../events/events.js";
import { DeliveryState, MessagingEventType, MessagingFailureReason, isActiveDeliveryState, AckType } from "../types/types.js";
import { assertDeliveryTransition } from "../lifecycle/lifecycle.js";
import { DataPlaneError, UnauthorizedSenderError } from "../errors.js";

export class DataPlaneRelayService {
  /**
   * @param {object} deps
   * @param {object} deps.repository a `{ messages, inbound, ackHistory }` bundle (in-memory or Mongo)
   * @param {MessagingEventBus} [deps.events] @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   */
  constructor(deps) {
    if (!deps || !deps.repository) throw new Error("DataPlaneRelayService requires { repository }");
    this.messages = deps.repository.messages;
    this.inbound = deps.repository.inbound ?? null;
    this.ackHistory = deps.repository.ackHistory ?? null;
    this.events = deps.events ?? new MessagingEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? undefined;
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  /**
   * A sender device relays an encrypted message through the server. Persists the ciphertext + delivery
   * metadata in the SENT state (awaiting the receiver to pull + ACK). @returns {Promise<object>} DTO
   */
  async relay({ actingDevice, conversationId, receiverDeviceId, encryptedPayload, priority, ttlMs, connectionId }) {
    validateRef(actingDevice, "sender device identifier");
    validateSendRequest({ conversationId, senderDeviceId: actingDevice, receiverDeviceId, encryptedPayload, priority, ttlMs });
    const seq = await this.messages.nextSequence(conversationId, actingDevice);
    const message = createMessage({ conversationId, senderDeviceId: actingDevice, receiverDeviceId, encryptedPayload, sequenceNumber: seq, priority, ttlMs, connectionId, clock: this.clock, idGenerator: this.idGenerator });
    // The relay accepts the message for delivery → SENT (the device's own engine tracks its finer FSM).
    message.state = DeliveryState.SENT;
    message.sentAt = this._nowIso();
    assertNoPlaintext(message, "message");
    const stored = await this.messages.create(message);
    this.events.emit(MessagingEventType.MESSAGE_SENT, { messageId: stored.messageId, conversationId, sender: actingDevice, receiver: receiverDeviceId, seq });
    return toPublicMessage(stored);
  }

  /**
   * The receiver pulls its undelivered messages for a conversation. Returns them WITH the opaque
   * ciphertext (so the receiver can decrypt) and advances each to DELIVERED. @returns {Promise<object[]>}
   */
  async inbox({ actingDevice, conversationId, limit }) {
    validateRef(actingDevice, "receiver device identifier");
    validateRef(conversationId, "conversation identifier");
    const all = await this.messages.listByConversation(String(conversationId), { limit });
    const mine = all.filter((m) => m.receiverDeviceId === String(actingDevice) && m.state === DeliveryState.SENT);
    const out = [];
    for (const m of mine) {
      const delivered = await this._transition(m, DeliveryState.DELIVERED, { patch: { deliveredAt: this._nowIso() }, event: MessagingEventType.MESSAGE_DELIVERED });
      if (this.inbound) await this.inbound.record({ messageId: m.messageId, conversationId: m.conversationId, senderDeviceId: m.senderDeviceId, receiverDeviceId: m.receiverDeviceId, encryptedPayload: m.encryptedPayload, sequenceNumber: m.sequenceNumber, receivedAt: this._nowIso(), deliveredAt: this._nowIso(), schemaVersion: 1 });
      out.push(toPublicMessage(delivered, { includePayload: true }));
    }
    return out;
  }

  /** The receiver acknowledges a delivered message. @returns {Promise<object>} DTO */
  async acknowledge({ actingDevice, messageId }) {
    validateRef(actingDevice, "receiver device identifier");
    const message = await this._require(messageId);
    if (String(message.receiverDeviceId) !== String(actingDevice)) {
      throw new UnauthorizedSenderError("Only the receiver can acknowledge this message", { details: { messageId } });
    }
    if (message.state === DeliveryState.ACKNOWLEDGED) return toPublicMessage(message);
    if (!isActiveDeliveryState(message.state)) {
      throw new DataPlaneError(`Cannot acknowledge a message in state "${message.state}"`, { code: "ERR_DATAPLANE_INVALID_TRANSITION", status: 409 });
    }
    const acked = await this._transition(message, DeliveryState.ACKNOWLEDGED, { patch: { ackedAt: this._nowIso(), nextRetryAt: null }, event: MessagingEventType.MESSAGE_ACKNOWLEDGED });
    if (this.ackHistory) await this.ackHistory.record({ ackId: `relay-${acked.messageId}`, messageId: acked.messageId, conversationId: acked.conversationId, ackType: AckType.ACK, direction: "received", seq: acked.sequenceNumber, at: this._nowIso(), schemaVersion: 1 });
    return toPublicMessage(acked);
  }

  /** A sender reads one of its message's delivery status. */
  async getStatus({ actingDevice, messageId }) {
    const message = await this._require(messageId);
    assertSender(message, actingDevice);
    return toDeliveryStatus(message);
  }

  /** A sender lists its still-pending (in-flight) messages for a conversation. */
  async getPending({ actingDevice, conversationId, limit }) {
    validateRef(conversationId, "conversation identifier");
    const all = await this.messages.listByConversation(String(conversationId), { limit });
    return all.filter((m) => m.senderDeviceId === String(actingDevice) && isActiveDeliveryState(m.state)).map(toMessageListItem);
  }

  /** Delivery history for a conversation (metadata only). */
  async getHistory({ conversationId, limit }) {
    validateRef(conversationId, "conversation identifier");
    return (await this.messages.listByConversation(String(conversationId), { limit })).map(toMessageListItem);
  }

  /** Aggregate delivery diagnostics for a conversation. */
  async getDiagnostics({ conversationId }) {
    validateRef(conversationId, "conversation identifier");
    const all = await this.messages.listByConversation(String(conversationId));
    const byState = {};
    for (const m of all) byState[m.state] = (byState[m.state] ?? 0) + 1;
    return { conversationId: String(conversationId), total: all.length, byState, role: "relay", canDecrypt: false };
  }

  /** @private */
  async _require(messageId) {
    validateMessageId(messageId);
    return requireMessage(await this.messages.findById(messageId), messageId);
  }

  /** @private guarded transition + persist + emit */
  async _transition(message, toState, options = {}) {
    assertDeliveryTransition(message.state, toState);
    const patch = { state: toState, version: (message.version ?? 0) + 1, updatedAt: this._nowIso(), ...(options.patch ?? {}) };
    if (options.patch) assertNoPlaintext(patch, "message");
    const updated = await this.messages.update(message.messageId, patch);
    if (options.event) this.events.emit(options.event, { messageId: updated.messageId, conversationId: updated.conversationId, sender: updated.senderDeviceId, receiver: updated.receiverDeviceId, seq: updated.sequenceNumber, state: toState, reason: options.reason });
    return updated;
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Factory. */
export function createDataPlaneRelayService(deps) {
  return new DataPlaneRelayService(deps);
}
