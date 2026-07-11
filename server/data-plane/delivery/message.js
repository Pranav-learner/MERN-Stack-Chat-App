/**
 * @module data-plane/delivery
 *
 * The **Message** model — the record factory + pure helpers for a transported application message.
 * Every send builds a message that binds a conversation + sender/receiver device to an OPAQUE
 * ciphertext payload, a per-conversation sequence number, a delivery state, and retransmission
 * bookkeeping.
 *
 * @security A message carries CIPHERTEXT ONLY (`encryptedPayload` is the crypto layer's envelope).
 * The data plane never decrypts it and never stores plaintext or key material. The `fragment` slot is
 * an inert placeholder a FUTURE fragmentation sprint fills.
 */

import crypto from "node:crypto";
import {
  DeliveryState,
  MessagePriority,
  DATAPLANE_SCHEMA_VERSION,
  DEFAULT_MESSAGE_TTL_MS,
} from "../types/types.js";

/**
 * Build a message in the {@link DeliveryState.CREATED} state.
 *
 * @param {object} params
 * @param {string} params.conversationId @param {string} params.senderDeviceId @param {string} params.receiverDeviceId
 * @param {object} params.encryptedPayload the ciphertext envelope (opaque; no plaintext)
 * @param {number} params.sequenceNumber per-conversation monotonic sequence
 * @param {string} [params.priority] one of {@link MessagePriority}
 * @param {string} [params.connectionId] the Layer-7 connection to use
 * @param {number} [params.ttlMs] @param {object} [params.metadata]
 * @param {string} [params.messageId] override id @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").Message}
 */
export function createMessage(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_MESSAGE_TTL_MS;

  return {
    messageId: params.messageId ?? idGenerator(),
    conversationId: String(params.conversationId),
    senderDeviceId: String(params.senderDeviceId),
    receiverDeviceId: String(params.receiverDeviceId),
    encryptedPayload: params.encryptedPayload, // OPAQUE ciphertext — never inspected
    sequenceNumber: params.sequenceNumber,
    timestamp: nowIso,
    priority: params.priority ?? MessagePriority.NORMAL,
    state: DeliveryState.CREATED,
    retryCount: 0,
    connectionId: params.connectionId ?? null,
    fragment: { fragmented: false, reserved: true }, // FUTURE placeholder — Sprint 2 fragmentation
    transportMetadata: {},
    auditMetadata: { createdAt: nowIso },
    sentAt: null,
    deliveredAt: null,
    ackedAt: null,
    nextRetryAt: null,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    version: 1,
    schemaVersion: DATAPLANE_SCHEMA_VERSION,
  };
}

/** Whether a message has passed its TTL. */
export function isMessageExpired(message, now = Date.now()) {
  if (!message?.expiresAt) return false;
  return new Date(message.expiresAt).getTime() <= now;
}

/** A stable idempotency/dedupe key for a message (per conversation + sequence). */
export function messageDedupeKey(conversationId, sequenceNumber) {
  return `${conversationId}#${sequenceNumber}`;
}
