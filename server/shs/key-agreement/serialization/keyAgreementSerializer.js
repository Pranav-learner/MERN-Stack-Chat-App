/**
 * @module shs/key-agreement/serialization
 *
 * Public DTOs for the key-agreement API. This is the **security guardrail** between
 * device-local secret material and anything that leaves the process (API responses,
 * logs, events):
 *
 *   - {@link toPublicSessionMaterial} STRIPS the `sharedSecret` and emits only its
 *     one-way fingerprint + metadata.
 *   - {@link toPublicExchange} emits the public coordination state (ephemeral PUBLIC
 *     keys + commitments), which contain no secret.
 *
 * If it isn't produced by one of these functions, it must not cross the network.
 */

/**
 * @typedef {object} PublicSessionMaterialDTO
 * @property {string} sessionId
 * @property {string} handshakeId
 * @property {string} sharedSecretFingerprint one-way commitment (NOT the secret)
 * @property {boolean} hasSharedSecret whether a secret is established (never the value)
 * @property {string} algorithm @property {string} cryptoVersion
 * @property {object} security @property {object} metadata
 * @property {string} createdAt @property {string} expiresAt
 */

/**
 * Shape session material into its public DTO — WITHOUT the shared secret.
 * @param {object} material @returns {PublicSessionMaterialDTO}
 */
export function toPublicSessionMaterial(material) {
  return {
    sessionId: material.sessionId,
    handshakeId: material.handshakeId,
    sharedSecretFingerprint: material.sharedSecretFingerprint,
    hasSharedSecret: !!material.sharedSecret,
    algorithm: material.algorithm,
    cryptoVersion: material.cryptoVersion,
    security: { ...(material.security ?? {}) },
    metadata: material.metadata ?? {},
    createdAt: toIso(material.createdAt),
    expiresAt: toIso(material.expiresAt),
    // NOTE: `sharedSecret` is intentionally omitted.
  };
}

/**
 * @typedef {object} PublicExchangeDTO
 * @property {string} handshakeId
 * @property {string} initiator @property {string} responder
 * @property {string} algorithm @property {string} cryptoVersion
 * @property {object|null} initiatorKey PUBLIC ephemeral key bundle (or null)
 * @property {object|null} responderKey
 * @property {boolean} initiatorCommitted @property {boolean} responderCommitted
 * @property {string} state @property {object} metadata
 * @property {string} createdAt @property {string} updatedAt @property {string} expiresAt
 */

/**
 * Shape a key-exchange record into its public DTO. Commitments are reduced to
 * booleans by default (they are one-way, but there's no need to surface them unless
 * asked) and ephemeral PUBLIC keys are passed through.
 * @param {object} exchange @param {{ includeCommitments?: boolean }} [options]
 * @returns {PublicExchangeDTO}
 */
export function toPublicExchange(exchange, options = {}) {
  const dto = {
    handshakeId: exchange.handshakeId,
    initiator: String(exchange.initiator),
    responder: String(exchange.responder),
    algorithm: exchange.algorithm,
    cryptoVersion: exchange.cryptoVersion,
    initiatorKey: exchange.initiatorKey ? publicBundle(exchange.initiatorKey) : null,
    responderKey: exchange.responderKey ? publicBundle(exchange.responderKey) : null,
    initiatorCommitted: !!exchange.initiatorCommitment,
    responderCommitted: !!exchange.responderCommitment,
    state: exchange.state,
    metadata: exchange.metadata ?? {},
    createdAt: toIso(exchange.createdAt),
    updatedAt: toIso(exchange.updatedAt),
    expiresAt: toIso(exchange.expiresAt),
  };
  if (options.includeCommitments) {
    dto.initiatorCommitment = exchange.initiatorCommitment;
    dto.responderCommitment = exchange.responderCommitment;
  }
  return dto;
}

/** Whitelist an ephemeral bundle's public fields. */
function publicBundle(bundle) {
  return {
    algorithm: bundle.algorithm,
    publicKey: bundle.publicKey,
    keyId: bundle.keyId,
    version: bundle.version,
    signature: bundle.signature,
    identityPublicKey: bundle.identityPublicKey,
    createdAt: bundle.createdAt,
  };
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
