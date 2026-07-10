/**
 * @module message-keys/metadata
 *
 * Metadata models for per-message keys — message metadata (number, generation, keyId,
 * fingerprint, direction, delivery), generation metadata, and security posture. All PUBLIC;
 * never key material.
 */

import crypto from "node:crypto";
import { MK_KDF, MK_KEY_BYTES, MK_VERSION, MK_SCHEMA_VERSION, DeliveryStatus, MessageKeyState } from "../types/types.js";

/**
 * Build a PUBLIC per-message metadata record.
 * @param {object} params `{ sessionId, direction, generation, messageNumber, keyId, fingerprint, state?, delivery?, at?, idGenerator? }`
 * @returns {import("../types/types.js").MessageMeta}
 */
export function createMessageMeta(params) {
  return {
    messageId: params.messageId ?? (params.idGenerator ? params.idGenerator() : crypto.randomUUID()),
    sessionId: String(params.sessionId),
    direction: params.direction,
    generation: params.generation,
    messageNumber: params.messageNumber,
    keyId: params.keyId,
    fingerprint: params.fingerprint,
    state: params.state ?? MessageKeyState.USED,
    delivery: params.delivery ?? DeliveryStatus.ENCRYPTED,
    at: params.at ?? new Date().toISOString(),
  };
}

/** Security posture metadata for the message-key engine. */
export function createSecurityMetadata() {
  return {
    kdf: MK_KDF,
    keyBytes: MK_KEY_BYTES,
    schemeVersion: MK_VERSION,
    schemaVersion: MK_SCHEMA_VERSION,
    perMessageKeys: true,
    ephemeralKeys: true,
    keyReuse: false, // each message key is used exactly once, then destroyed
    // Explicitly NOT implemented in this sprint:
    doubleRatchet: false,
    postCompromiseSecurity: false,
  };
}

/**
 * Summary of a session's message activity (counts + delivery).
 * @param {import("../types/types.js").MessageKeyState_} record @returns {object}
 */
export function createGenerationMetadata(record) {
  return {
    generation: record.generation ?? 0,
    sent: record.sending?.count ?? 0,
    received: record.receiving?.count ?? 0,
    lastSentNumber: record.sending?.lastNumber ?? -1,
    lastReceivedNumber: record.receiving?.lastNumber ?? -1,
    highestReceivedNumber: record.receiving?.highestNumber ?? -1,
  };
}

/** Recompute the derived metadata block from a live record. */
export function recomputeMetadata(record) {
  return { generation: createGenerationMetadata(record) };
}
