/**
 * @module key-hierarchy/serialization
 *
 * Public DTOs for key-hierarchy state. Whitelists PUBLIC fields — the root-key metadata, the
 * sending/receiving chain metadata, archived chains, and derived summaries.
 *
 * @security A hierarchy record never carries key bytes; this layer also defensively strips
 * anything key-like. Chain keys + the root key live only in the device key store.
 */

/**
 * @typedef {object} PublicHierarchyDTO
 * @property {string} sessionId @property {string} [handshakeId] @property {string} role
 * @property {number} generation @property {object} rootKey @property {object} sendingChain @property {object} receivingChain
 * @property {object[]} archivedChains @property {object} metadata @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */

/**
 * Shape a hierarchy record into its public DTO.
 * @param {object} state @param {{ includeAudit?: boolean, includeHistory?: boolean }} [options]
 * @returns {PublicHierarchyDTO}
 */
export function toPublicHierarchy(state, options = {}) {
  const dto = {
    sessionId: state.sessionId,
    handshakeId: state.handshakeId,
    role: state.role,
    generation: state.generation ?? 0,
    rootKey: toPublicRootKey(state.rootKey),
    sendingChain: toPublicChain(state.sendingChain, options),
    receivingChain: toPublicChain(state.receivingChain, options),
    archivedChains: (state.archivedChains ?? []).map((c) => toPublicChain(c, { includeHistory: false })),
    metadata: { ...(state.metadata ?? {}) },
    security: { ...(state.security ?? {}) },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    schemaVersion: state.schemaVersion,
  };
  if (options.includeAudit) dto.audit = (state.audit ?? []).map((a) => ({ ...a }));
  return dto;
}

/** Root-key PUBLIC metadata (never bytes). */
export function toPublicRootKey(rootKey) {
  if (!rootKey) return null;
  return {
    rootKeyId: rootKey.rootKeyId,
    fingerprint: rootKey.fingerprint,
    generation: rootKey.generation,
    version: rootKey.version,
    status: rootKey.status,
    createdAt: rootKey.createdAt,
    supersededAt: rootKey.supersededAt,
    destroyedAt: rootKey.destroyedAt,
  };
}

/** Chain PUBLIC metadata (never the chain key bytes). */
export function toPublicChain(chain, options = {}) {
  if (!chain) return null;
  const dto = {
    chainId: chain.chainId,
    direction: chain.direction,
    role: chain.role,
    generation: chain.generation,
    index: chain.index,
    version: chain.version,
    chainKeyId: chain.chainKeyId,
    fingerprint: chain.fingerprint,
    status: chain.status,
    createdAt: chain.createdAt,
    archivedAt: chain.archivedAt,
  };
  if (options.includeHistory !== false) dto.history = (chain.history ?? []).map((h) => ({ ...h }));
  return dto;
}

/** A compact status view — generation + chain indexes. */
export function toHierarchyStatus(state) {
  return {
    sessionId: state.sessionId,
    generation: state.generation ?? 0,
    rootKeyId: state.rootKey?.rootKeyId ?? null,
    sendingIndex: state.sendingChain?.index ?? 0,
    receivingIndex: state.receivingChain?.index ?? 0,
    established: Boolean(state.rootKey),
  };
}
