/**
 * @module message-keys/serialization
 *
 * Public DTOs for message-key state. Whitelists PUBLIC fields — per-session counters,
 * generation, and message metadata (numbers, key ids, fingerprints, delivery).
 *
 * @security A message-key record never carries key bytes. Message keys are ephemeral and
 * live only transiently in memory; this layer only ever sees METADATA.
 */

/**
 * @typedef {object} PublicMessageKeyDTO
 * @property {string} sessionId @property {string} [handshakeId] @property {number} generation
 * @property {object} sending @property {object} receiving
 * @property {object} metadata @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */

/**
 * Shape a message-key state record into its public DTO.
 * @param {object} state @param {{ includeMessages?: boolean, includeAudit?: boolean }} [options]
 * @returns {PublicMessageKeyDTO}
 */
export function toPublicMessageKeyState(state, options = {}) {
  const dto = {
    sessionId: state.sessionId,
    handshakeId: state.handshakeId,
    generation: state.generation ?? 0,
    sending: { ...(state.sending ?? { count: 0, lastNumber: -1 }) },
    receiving: { ...(state.receiving ?? { count: 0, lastNumber: -1, highestNumber: -1 }) },
    metadata: { ...(state.metadata ?? {}) },
    security: { ...(state.security ?? {}) },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    schemaVersion: state.schemaVersion,
  };
  if (options.includeMessages) dto.messages = (state.messages ?? []).map(toPublicMessageMeta);
  if (options.includeAudit) dto.audit = (state.audit ?? []).map((a) => ({ ...a }));
  return dto;
}

/** One message's PUBLIC metadata (never key bytes). */
export function toPublicMessageMeta(m) {
  return {
    messageId: m.messageId,
    direction: m.direction,
    generation: m.generation,
    messageNumber: m.messageNumber,
    keyId: m.keyId,
    fingerprint: m.fingerprint,
    state: m.state,
    delivery: m.delivery,
    at: m.at,
  };
}

/** A compact status view — counts + last message numbers. */
export function toMessageKeyStatus(state) {
  return {
    sessionId: state.sessionId,
    generation: state.generation ?? 0,
    sent: state.sending?.count ?? 0,
    received: state.receiving?.count ?? 0,
    lastSentNumber: state.sending?.lastNumber ?? -1,
    lastReceivedNumber: state.receiving?.lastNumber ?? -1,
  };
}
