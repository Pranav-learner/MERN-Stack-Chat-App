/**
 * @module group-communication/messaging/groupMessage
 *
 * The **group message** model — pure helpers for the record that represents one message sent to a group.
 * A group message references the group + the KEY VERSION it was encrypted under and carries OPAQUE
 * ciphertext only; the engine never encrypts or inspects it (the device already produced the ciphertext
 * with its device-local group key). This is the record fan-out delivers and synchronization reconciles.
 *
 * @security A group message carries `{ groupId, senderId, keyVersion, ciphertext, contentHash }` — the
 * ciphertext is opaque bytes/string; `contentHash` is a divergence detector, never the plaintext. No
 * plaintext or key material is ever stored (enforced by {@link module:group-communication/validators}).
 *
 * Pure functions, no I/O — every helper returns plain data.
 */

import crypto from "node:crypto";
import { GROUP_COMM_SCHEMA_VERSION, DeliveryPriority } from "../types/types.js";
import { GroupCommValidationError } from "../errors.js";

/** A short unique message id. */
export function newGroupMessageId(idGenerator) {
  return idGenerator ? idGenerator() : crypto.randomUUID();
}

/** An opaque content hash over the ciphertext (divergence detection, never plaintext). */
export function ciphertextHash(ciphertext) {
  const buf = typeof ciphertext === "string" ? Buffer.from(ciphertext, "utf8") : Buffer.from(ciphertext ?? []);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Build a group message record. @param {object} params
 * @param {string} params.groupId @param {string} params.senderId @param {number} params.keyVersion
 * @param {string|Uint8Array} params.ciphertext OPAQUE encrypted payload @param {string} [params.conversationId]
 * @param {string} [params.priority] @param {object} [params.metadata] non-secret metadata (e.g. contentType)
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {object}
 */
export function createGroupMessage(params) {
  if (params.ciphertext == null || (typeof params.ciphertext !== "string" && !(params.ciphertext instanceof Uint8Array) && !Buffer.isBuffer(params.ciphertext))) {
    throw new GroupCommValidationError("group message requires opaque ciphertext (string or bytes)");
  }
  const clock = params.clock ?? (() => Date.now());
  const nowIso = new Date(clock()).toISOString();
  const ciphertext = params.ciphertext instanceof Uint8Array || Buffer.isBuffer(params.ciphertext) ? Buffer.from(params.ciphertext).toString("base64") : String(params.ciphertext);
  return {
    messageId: newGroupMessageId(params.idGenerator),
    groupId: String(params.groupId),
    conversationId: params.conversationId ?? `group:${params.groupId}`,
    senderId: String(params.senderId),
    keyVersion: Number(params.keyVersion),
    ciphertext, // opaque
    contentHash: ciphertextHash(ciphertext),
    priority: params.priority ?? DeliveryPriority.NORMAL,
    metadata: params.metadata ?? {},
    createdAt: nowIso,
    schemaVersion: GROUP_COMM_SCHEMA_VERSION,
  };
}

/** A compact reference to a group message (no ciphertext) — for events + DTOs. */
export function groupMessageRef(message) {
  return { messageId: message.messageId, groupId: message.groupId, senderId: message.senderId, keyVersion: message.keyVersion, contentHash: message.contentHash, priority: message.priority, createdAt: message.createdAt };
}
