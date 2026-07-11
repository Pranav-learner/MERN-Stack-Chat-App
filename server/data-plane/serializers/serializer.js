/**
 * @module data-plane/serializers
 *
 * Public DTOs for the data plane. Whitelists PUBLIC fields for a message + compact delivery-status
 * views. A message DTO EXCLUDES the ciphertext by default (delivery metadata is what an API/status
 * caller needs); pass `includePayload` only when the app itself must read the opaque ciphertext to
 * decrypt it.
 *
 * @security The default DTO never carries the payload; even when included, the payload is opaque
 * ciphertext, never plaintext.
 */

import { DELIVERED_STATES, TERMINAL_DELIVERY_STATES, ACTIVE_DELIVERY_STATES } from "../types/types.js";

const DELIVERED = new Set(DELIVERED_STATES);
const TERMINAL = new Set(TERMINAL_DELIVERY_STATES);
const ACTIVE = new Set(ACTIVE_DELIVERY_STATES);

/** Shape a message into its public DTO. Excludes the ciphertext unless `includePayload`. */
export function toPublicMessage(m, context = {}) {
  if (!m) return null;
  const dto = {
    messageId: m.messageId,
    conversationId: m.conversationId,
    senderDeviceId: m.senderDeviceId,
    receiverDeviceId: m.receiverDeviceId,
    sequenceNumber: m.sequenceNumber,
    timestamp: m.timestamp,
    priority: m.priority,
    state: m.state,
    delivered: DELIVERED.has(m.state),
    terminal: TERMINAL.has(m.state),
    active: ACTIVE.has(m.state),
    retryCount: m.retryCount ?? 0,
    connectionId: m.connectionId ?? null,
    sentAt: m.sentAt ?? null,
    deliveredAt: m.deliveredAt ?? null,
    ackedAt: m.ackedAt ?? null,
    expiresAt: m.expiresAt,
    nextRetryAt: m.nextRetryAt ?? null,
    version: m.version,
    schemaVersion: m.schemaVersion,
  };
  if (context.includePayload) dto.encryptedPayload = m.encryptedPayload; // OPAQUE ciphertext
  return dto;
}

/** A compact delivery-status view (for polling). */
export function toDeliveryStatus(m) {
  return {
    messageId: m.messageId,
    conversationId: m.conversationId,
    state: m.state,
    delivered: DELIVERED.has(m.state),
    terminal: TERMINAL.has(m.state),
    retryCount: m.retryCount ?? 0,
    sequenceNumber: m.sequenceNumber,
    sentAt: m.sentAt ?? null,
    ackedAt: m.ackedAt ?? null,
    expiresAt: m.expiresAt,
  };
}

/** A compact list-item view (pending queue / history). */
export function toMessageListItem(m) {
  return {
    messageId: m.messageId,
    conversationId: m.conversationId,
    receiverDeviceId: m.receiverDeviceId,
    sequenceNumber: m.sequenceNumber,
    state: m.state,
    priority: m.priority,
    retryCount: m.retryCount ?? 0,
    timestamp: m.timestamp,
  };
}
