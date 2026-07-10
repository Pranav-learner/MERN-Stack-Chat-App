/**
 * @module shs/session/serialization
 *
 * Public DTO for a Secure Session. This is the API/network guardrail: it whitelists
 * PUBLIC fields — session identity, participants, lifecycle status, timing, and key
 * METADATA (algorithm, length, keyId, fingerprint). Session records never contain
 * raw keys, but this layer also defensively strips anything key-like.
 */

/**
 * @typedef {object} PublicSessionDTO
 * @property {string} sessionId @property {string} handshakeId
 * @property {string[]} participants @property {object} deviceIds
 * @property {string} protocolVersion
 * @property {{ algorithm: string, length: number, keyId: string, fingerprint: string }} encryptionKey key METADATA
 * @property {{ algorithm: string, length: number }} authenticationKey key METADATA
 * @property {string} status @property {number} generation
 * @property {Array<object>} rekeyHistory
 * @property {string} createdAt @property {string} lastActivityAt @property {string} expiresAt
 * @property {number} maxLifetimeMs @property {number} idleTimeoutMs
 * @property {object} security @property {object} metadata @property {object} extensions
 * @property {boolean} isActive @property {boolean} isExpired
 */

const ACTIVE = new Set(["created", "active", "idle", "paused", "resumed"]);

/**
 * Shape a session record into its public DTO.
 * @param {object} session
 * @param {{ now?: number, role?: string }} [context]
 * @returns {PublicSessionDTO}
 */
export function toPublicSession(session, context = {}) {
  const now = context.now ?? Date.now();
  const expired = session.expiresAt ? new Date(session.expiresAt).getTime() <= now : false;
  return {
    sessionId: session.sessionId,
    handshakeId: session.handshakeId,
    participants: (session.participants ?? []).map(String),
    deviceIds: {
      initiator: session.deviceIds?.initiator,
      responder: session.deviceIds?.responder,
    },
    protocolVersion: session.protocolVersion,
    // key METADATA only — never bytes.
    encryptionKey: {
      algorithm: session.encryptionKey?.algorithm,
      length: session.encryptionKey?.length,
      keyId: session.encryptionKey?.keyId,
      fingerprint: session.encryptionKey?.fingerprint,
    },
    authenticationKey: {
      algorithm: session.authenticationKey?.algorithm,
      length: session.authenticationKey?.length,
    },
    status: session.status,
    generation: session.generation ?? 0,
    rekeyHistory: (session.rekeyHistory ?? []).map((r) => ({ ...r })),
    createdAt: toIso(session.createdAt),
    lastActivityAt: toIso(session.lastActivityAt),
    expiresAt: toIso(session.expiresAt),
    maxLifetimeMs: session.maxLifetimeMs,
    idleTimeoutMs: session.idleTimeoutMs,
    security: { ...(session.security ?? {}) },
    metadata: session.metadata ?? {},
    extensions: session.extensions ?? {},
    role: context.role,
    isActive: ACTIVE.has(session.status) && !expired,
    isExpired: expired,
  };
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
