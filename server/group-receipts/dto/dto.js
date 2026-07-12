/**
 * @module group-receipts/dto
 *
 * **Request DTOs + normalizers** for the Group Delivery Intelligence subsystem. Normalizes loose
 * HTTP/client input into the exact parameter objects the manager expects, so the controller stays thin.
 * Pure functions, no I/O.
 */

const id = (v) => (v == null ? undefined : String(v));

/**
 * @typedef {object} RegisterMessageDTO
 * @property {string} messageId @property {string} groupId @property {string} senderId
 * @property {string[]} applicableMembers members that must receive it (sender auto-excluded by policy)
 * @property {string} [sentAt] @property {object} [policy] @property {string[]} [readExcludedMembers]
 */

/** Normalize a register-message request. */
export function normalizeRegister(input = {}) {
  return {
    messageId: id(input.messageId),
    groupId: id(input.groupId),
    senderId: id(input.senderId),
    applicableMembers: Array.isArray(input.applicableMembers) ? input.applicableMembers.map(id) : [],
    readExcludedMembers: Array.isArray(input.readExcludedMembers) ? input.readExcludedMembers.map(id) : [],
    sentAt: input.sentAt,
    policy: input.policy,
  };
}

/** Normalize a track-delivery request. */
export function normalizeDelivery(input = {}) {
  return { messageId: id(input.messageId), memberId: id(input.memberId), deviceId: id(input.deviceId ?? input.memberId), status: input.status, at: input.at, deviceMeta: input.deviceMeta };
}

/** Normalize a track-read request. */
export function normalizeRead(input = {}) {
  return { messageId: id(input.messageId), memberId: id(input.memberId), deviceId: id(input.deviceId ?? input.memberId), at: input.at };
}

/** Normalize a receipt-status query. */
export function normalizeQuery(input = {}) {
  return { messageId: id(input.messageId), actingMember: id(input.actingMember) };
}
