/**
 * @module secure-transport/repositories/ciphertextRepository
 *
 * Ciphertext storage contract + an in-memory reference/test implementation. The relay
 * persists ONLY: ciphertext + metadata + session references + delivery metadata +
 * timestamp. It NEVER stores plaintext, encryption keys, or shared secrets.
 *
 * In production the Mongo `Message` model is the ciphertext store (its `secure`
 * subdoc). This module is the transport-independent contract + a zero-dep in-memory
 * backend for tests.
 *
 * @security {@link toStoredCiphertext} strips any accidental plaintext + key material
 * before persistence — a defensive guarantee that only ciphertext + metadata is stored.
 */

import { metadataOf } from "../payload/securePayload.js";

/**
 * Shape a {@link SecurePayload} into the record persisted by the relay. Whitelists
 * ciphertext + metadata; drops anything else.
 * @param {object} payload @param {{ senderId?: string, receiverId?: string, deliveredAt?: number }} [routing]
 * @returns {object} the stored ciphertext record
 */
export function toStoredCiphertext(payload, routing = {}) {
  const meta = metadataOf(payload);
  return {
    // routing (server knows these from the authenticated request)
    senderId: routing.senderId ? String(routing.senderId) : undefined,
    receiverId: routing.receiverId ? String(routing.receiverId) : undefined,
    // secure envelope (ciphertext + metadata ONLY — no plaintext, no keys)
    secure: {
      encrypted: true,
      v: meta.v,
      payloadVersion: meta.payloadVersion,
      type: meta.type,
      protocolVersion: meta.protocolVersion,
      sessionId: meta.sessionId,
      keyId: meta.keyId,
      senderDevice: meta.senderDevice,
      receiverDevice: meta.receiverDevice,
      // The exact AAD timestamp MUST be preserved so the receiver can reconstruct the
      // authenticated metadata and decrypt (Mongoose's own createdAt is separate).
      timestamp: meta.timestamp,
      nonce: meta.nonce,
      algorithm: payload.encryption.algorithm,
      iv: payload.encryption.iv,
      ciphertext: payload.encryption.ciphertext,
      tag: payload.encryption.tag,
      macAlgorithm: payload.integrity.algorithm,
      mac: payload.integrity.mac,
    },
    // delivery metadata
    status: "sent",
    createdAt: meta.timestamp,
    deliveredAt: routing.deliveredAt,
  };
}

/** Reconstruct a {@link SecurePayload} from a stored ciphertext record (for delivery). */
export function fromStoredCiphertext(record) {
  const s = record.secure;
  return {
    v: s.v,
    payloadVersion: s.payloadVersion,
    type: s.type,
    protocolVersion: s.protocolVersion,
    sessionId: s.sessionId,
    keyId: s.keyId,
    senderDevice: s.senderDevice,
    receiverDevice: s.receiverDevice,
    timestamp: s.timestamp ?? record.createdAt,
    nonce: s.nonce,
    encryption: { algorithm: s.algorithm, iv: s.iv, ciphertext: s.ciphertext, tag: s.tag },
    integrity: { algorithm: s.macAlgorithm, mac: s.mac },
    ratchet: null,
  };
}

/** In-memory ciphertext repository (tests / reference). Stores records deep-copied. */
export function createInMemoryCiphertextRepository() {
  const byId = new Map();
  let seq = 0;
  const clone = (v) => structuredClone(v);
  const store = {
    async create(record) {
      const id = `msg-${++seq}`;
      const stored = { _id: id, ...clone(record) };
      byId.set(id, stored);
      return clone(stored);
    },
    async findById(id) {
      return byId.has(id) ? clone(byId.get(id)) : null;
    },
    async listBetween(a, b) {
      return [...byId.values()]
        .filter(
          (m) =>
            (String(m.senderId) === String(a) && String(m.receiverId) === String(b)) ||
            (String(m.senderId) === String(b) && String(m.receiverId) === String(a)),
        )
        .map(clone);
    },
    async markDelivered(id, at) {
      const m = byId.get(id);
      if (!m) return false;
      m.status = "delivered";
      m.deliveredAt = at;
      return true;
    },
  };
  return { messages: store, reset: () => byId.clear() };
}
