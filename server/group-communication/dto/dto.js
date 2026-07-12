/**
 * @module group-communication/dto
 *
 * **Request DTOs + normalizers** for the Group Communication Engine. Normalizes loose HTTP/client input
 * into the exact parameter objects the engine expects, so the controller stays thin and every entry
 * point coerces input the same way. Pure functions, no I/O.
 *
 * @security Normalizers pass ciphertext + metadata straight through to the validators layer, which
 * enforces the no-secret invariant — they never fabricate or strip security-relevant fields silently.
 */

const id = (v) => (v == null ? undefined : String(v));

/**
 * @typedef {object} SendGroupMessageDTO
 * @property {string} groupId @property {string} senderId @property {string} senderDeviceId
 * @property {string|Uint8Array} ciphertext OPAQUE @property {number} [keyVersion] @property {string} [priority]
 * @property {object} [metadata]
 */

/** Normalize a send-group-message request. */
export function normalizeSend(input = {}) {
  return {
    groupId: id(input.groupId),
    senderId: id(input.senderId),
    senderDeviceId: id(input.senderDeviceId),
    ciphertext: input.ciphertext,
    keyVersion: input.keyVersion != null ? Number(input.keyVersion) : undefined,
    priority: input.priority,
    metadata: input.metadata,
  };
}

/** Normalize a rotate-key (rekey) request. */
export function normalizeRotateKey(input = {}) {
  return { groupId: id(input.groupId), actorId: id(input.actorId), fingerprint: input.fingerprint, trigger: input.trigger, ttlMs: input.ttlMs };
}

/** Normalize an establish-initial-key request. */
export function normalizeEstablishKey(input = {}) {
  return { groupId: id(input.groupId), actorId: id(input.actorId), fingerprint: input.fingerprint, ttlMs: input.ttlMs };
}

/** Normalize a synchronize-group request. */
export function normalizeSync(input = {}) {
  return { groupId: id(input.groupId), deviceId: id(input.deviceId), memberId: id(input.memberId), replica: input.replica, cursor: input.cursor };
}

/** Normalize a mark-online / reconnect request. */
export function normalizeReconnect(input = {}) {
  return { groupId: id(input.groupId), memberId: id(input.memberId), deviceId: id(input.deviceId) };
}

/** Normalize a delivery-status query. */
export function normalizeDeliveryQuery(input = {}) {
  return { groupId: id(input.groupId), messageId: id(input.messageId) };
}
