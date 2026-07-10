/**
 * @module key-hierarchy/types
 *
 * Enums and type declarations for the **Key Hierarchy & Chain Management** subsystem
 * (Layer 5, Sprint 4). This sprint replaces the flat session-key model with a structured
 * cryptographic hierarchy inspired by modern secure-messaging protocols:
 *
 * ```
 * Session Root Key
 *   ├── Sending Chain   (chain key ratchet)
 *   └── Receiving Chain (chain key ratchet)
 * ```
 *
 * ## Scope
 * This sprint builds the hierarchy + chain management ONLY. It does NOT derive
 * per-message keys, and it does NOT implement a Double Ratchet or Post-Compromise
 * Security. Advancing a chain ratchets its chain key forward (one-way) and moves the chain
 * index; the **message-key derivation is a Sprint 5 extension point** hung off the current
 * chain key.
 *
 * @security The Session Root Key and chain keys are SECRET, device-local material. They
 * live ONLY in the {@link module:key-hierarchy/keystore} and are never serialized,
 * persisted, logged, or returned by an API. Repositories, DTOs, events, and audit records
 * carry METADATA only (key ids, fingerprints, generations, chain indexes, timestamps).
 *
 * @hierarchy The root key is derived from the Sprint 2 forward-secrecy generation's
 * reserved `ratchetMaterial`, so the hierarchy inherits forward secrecy: each rekey
 * re-roots the hierarchy and archives the previous chains.
 */

/**
 * Canonical, peer-symmetric chain directions. A device's *sending* chain in one direction
 * is the peer's *receiving* chain in the same direction, so both peers derive matching
 * chains from the same root (interop groundwork for Sprint 5 message keys).
 *
 * - `I2R` — initiator → responder.
 * - `R2I` — responder → initiator.
 * @readonly @enum {string}
 */
export const ChainDirection = Object.freeze({
  I2R: "i2r",
  R2I: "r2i",
});

/**
 * A chain's role relative to THIS device (derived from its `role` + direction).
 * @readonly @enum {string}
 */
export const ChainRole = Object.freeze({
  SENDING: "sending",
  RECEIVING: "receiving",
});

/** This device's role in the session (decides which direction is sending/receiving). */
export const DeviceRole = Object.freeze({
  INITIATOR: "initiator",
  RESPONDER: "responder",
});

/**
 * Chain lifecycle status.
 * - `ACTIVE`    — the current chain for its role.
 * - `ARCHIVED`  — superseded by a re-root (a newer generation's chain is active).
 * - `DESTROYED` — chain key wiped (terminal).
 * @readonly @enum {string}
 */
export const ChainStatus = Object.freeze({
  ACTIVE: "active",
  ARCHIVED: "archived",
  DESTROYED: "destroyed",
});

/**
 * Root-key lifecycle status.
 * @readonly @enum {string}
 */
export const RootKeyStatus = Object.freeze({
  ACTIVE: "active",
  SUPERSEDED: "superseded", // a newer generation re-rooted the hierarchy
  DESTROYED: "destroyed",
});

/**
 * Key-hierarchy event types. Future layers (Sprint 5 message keys) consume these.
 * @readonly @enum {string}
 */
export const KeyHierarchyEventType = Object.freeze({
  ROOT_KEY_CREATED: "hierarchy.root_key_created",
  ROOT_KEY_SUPERSEDED: "hierarchy.root_key_superseded",
  CHAIN_CREATED: "hierarchy.chain_created",
  CHAIN_ADVANCED: "hierarchy.chain_advanced",
  CHAIN_ARCHIVED: "hierarchy.chain_archived",
  CHAIN_VALIDATED: "hierarchy.chain_validated",
  CHAIN_LOADED: "hierarchy.chain_loaded",
  HIERARCHY_DESTROYED: "hierarchy.destroyed",
  // FUTURE (Sprint 5+) — declared so consumers can subscribe ahead of time.
  MESSAGE_KEY_GENERATED: "hierarchy.message_key_generated",
  RATCHET_ADVANCED: "hierarchy.ratchet_advanced",
});

/**
 * Machine-readable failure reasons.
 * @readonly @enum {string}
 */
export const KeyHierarchyFailureReason = Object.freeze({
  UNKNOWN_SESSION: "unknown-session",
  NOT_ESTABLISHED: "not-established",
  ALREADY_ESTABLISHED: "already-established",
  INVALID_ROOT_KEY: "invalid-root-key",
  CHAIN_MISMATCH: "chain-mismatch",
  GENERATION_MISMATCH: "generation-mismatch",
  INDEX_ROLLBACK: "index-rollback",
  CORRUPTED_METADATA: "corrupted-metadata",
  MISSING_CHAIN: "missing-chain",
  DUPLICATE_CHAIN: "duplicate-chain",
  MALFORMED_STATE: "malformed-state",
  KEYSTORE_REQUIRED: "keystore-required",
  DERIVATION_ERROR: "derivation-error",
  INTERNAL_ERROR: "internal-error",
});

/** KDF used across the hierarchy (matches the rest of Layer 4/5). */
export const KH_KDF = "hkdf-sha256";
/** Byte length of the root key + chain keys. */
export const KH_KEY_BYTES = 32;
/** Derivation namespace for the key hierarchy. */
export const KH_NAMESPACE = "securechat-kh";
/** Scheme version baked into derivation labels (bump to rotate the whole hierarchy). */
export const KH_VERSION = 1;
/** The first hierarchy generation. */
export const INITIAL_GENERATION = 0;
/** The first chain index. */
export const INITIAL_INDEX = 0;
/** Current key-hierarchy metadata storage schema version. */
export const KH_SCHEMA_VERSION = 1;

/**
 * @typedef {object} RootKeyMeta PUBLIC root-key metadata (never the key bytes).
 * @property {string} rootKeyId @property {string} fingerprint
 * @property {number} generation @property {number} version @property {string} status
 * @property {string} createdAt @property {string} [supersededAt] @property {string} [destroyedAt]
 */

/**
 * @typedef {object} ChainMeta PUBLIC chain metadata (never the chain key bytes).
 * @property {string} chainId @property {string} direction one of {@link ChainDirection}
 * @property {string} role one of {@link ChainRole} @property {number} generation
 * @property {number} index the chain's ratchet position (message-key slot in Sprint 5)
 * @property {number} version @property {string} chainKeyId @property {string} fingerprint
 * @property {string} status one of {@link ChainStatus}
 * @property {string} createdAt @property {string} [archivedAt]
 * @property {Array<{ index: number, fingerprint: string, at: string, reason?: string }>} history
 */

/**
 * @typedef {object} KeyHierarchyState PUBLIC per-session hierarchy sidecar (metadata only).
 * @property {string} sessionId @property {string} [handshakeId] @property {string} role
 * @property {number} generation @property {RootKeyMeta} rootKey
 * @property {ChainMeta} sendingChain @property {ChainMeta} receivingChain
 * @property {ChainMeta[]} archivedChains @property {RootKeyMeta[]} rootHistory
 * @property {object[]} audit @property {object} metadata @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */
