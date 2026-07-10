/**
 * @module forward-secrecy/types
 *
 * Enums and type declarations for the **Forward Secrecy Engine** (Layer 5, Sprint 2).
 * This sprint turns the Sprint 1 Session Evolution Framework's *metadata-only*
 * generations into **real cryptographic evolution**: every generation derives fresh
 * session key material from a one-way KDF chain, and obsolete secrets are securely
 * destroyed.
 *
 * ## Forward secrecy model (how this sprint achieves it)
 * A session holds a device-local **generation-secret chain**. To evolve from generation
 * `n` to `n+1`:
 *   1. `chainSecret_{n+1} = HKDF(chainSecret_n, "fs-chain-evolve|gen=n+1")` — a ONE-WAY
 *      step (you cannot compute `chainSecret_n` from `chainSecret_{n+1}`);
 *   2. fresh session keys are derived from `chainSecret_{n+1}`;
 *   3. `chainSecret_n` and generation-`n` keys are **securely destroyed**.
 * Because the chain is one-way and past secrets are wiped, compromising the current
 * state cannot recover PAST session keys — that is forward secrecy.
 *
 * @security This IS a cryptographic module. It derives, activates, and destroys SECRET
 * key material. Secrets live ONLY in the device-local {@link module:forward-secrecy/keystore}
 * and are NEVER serialized, persisted to the server, logged, or returned by any API —
 * repositories, DTOs, events, and audit records carry METADATA only (generation numbers,
 * key ids, fingerprints, algorithms, timestamps).
 *
 * @forward-secrecy Out of scope for this sprint (later Layer 5+): Double Ratchet, Chain
 * Keys, per-Message Keys, and Post-Compromise Security. This engine evolves *session
 * generations* only. Future sprints derive chain/message keys FROM this evolving state.
 */

/**
 * Lifecycle status of a single cryptographic generation.
 *
 * - `PENDING`    — derived but not yet activated (transient, during evolution).
 * - `ACTIVE`     — the current generation used to encrypt new messages.
 * - `SUPERSEDED` — a newer generation is active; retained briefly for in-flight decrypt.
 * - `EXPIRED`    — past its retention window; scheduled for destruction.
 * - `DESTROYED`  — key material securely wiped (terminal).
 * @readonly @enum {string}
 */
export const GenerationStatus = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  EXPIRED: "expired",
  DESTROYED: "destroyed",
});

/** All generation statuses. */
export const ALL_GENERATION_STATUSES = Object.freeze(Object.values(GenerationStatus));

/** Statuses whose key material still exists in the device store. */
export const LIVE_GENERATION_STATUSES = Object.freeze([
  GenerationStatus.PENDING,
  GenerationStatus.ACTIVE,
  GenerationStatus.SUPERSEDED,
]);

/**
 * Forward-secrecy engine event types. Future layers consume these.
 * @readonly @enum {string}
 */
export const ForwardSecrecyEventType = Object.freeze({
  FORWARD_SECRECY_STARTED: "fs.started",
  GENERATION_CREATED: "fs.generation_created",
  GENERATION_ADVANCED: "fs.generation_advanced",
  GENERATION_ACTIVATED: "fs.generation_activated",
  KEYS_DESTROYED: "fs.keys_destroyed",
  GENERATION_DESTROYED: "fs.generation_destroyed",
  EVOLUTION_COMPLETED: "fs.evolution_completed",
  EVOLUTION_FAILED: "fs.evolution_failed",
  POLICY_TRIGGERED: "fs.policy_triggered",
  VALIDATION_FAILURE: "fs.validation_failure",
  TRANSPORT_UPDATED: "fs.transport_updated",
});

/**
 * Why a piece of key material was destroyed (recorded on audit + destruction records).
 * @readonly @enum {string}
 */
export const DestructionReason = Object.freeze({
  SUPERSEDED: "superseded", // a newer generation replaced it
  RETENTION_EXPIRED: "retention-expired", // aged out of the retain window
  FAILED_EVOLUTION: "failed-evolution", // intermediate material from a failed evolve
  TEMPORARY: "temporary", // a transient/intermediate secret
  SESSION_ENDED: "session-ended", // the whole session was torn down
  MANUAL: "manual",
});

/**
 * What triggered an evolution (mirrors the evolution-framework triggers).
 * @readonly @enum {string}
 */
export const EvolutionTrigger = Object.freeze({
  MANUAL: "manual",
  SCHEDULED: "scheduled",
  SECURITY_EVENT: "security-event",
  POLICY: "policy",
  SYSTEM: "system",
});

/**
 * Machine-readable failure reasons for validation + evolution errors.
 * @readonly @enum {string}
 */
export const ForwardSecrecyFailureReason = Object.freeze({
  UNKNOWN_SESSION: "unknown-session",
  NOT_STARTED: "not-started",
  ALREADY_STARTED: "already-started",
  GENERATION_ORDERING: "generation-ordering",
  ROLLBACK_DETECTED: "rollback-detected",
  REPLAY_DETECTED: "replay-detected",
  DESTROYED_KEY_REFERENCE: "destroyed-key-reference",
  VERSION_INCONSISTENT: "version-inconsistent",
  SESSION_OWNERSHIP: "session-ownership",
  INVALID_SESSION_STATE: "invalid-session-state",
  MALFORMED_REQUEST: "malformed-request",
  KEY_DERIVATION: "key-derivation",
  INTERNAL_ERROR: "internal-error",
});

/** KDF used for the generation-secret chain (matches the Layer 4 session KDF). */
export const FS_KDF = "hkdf-sha256";
/** Byte length of a chain secret + derived symmetric keys. */
export const CHAIN_SECRET_BYTES = 32;
/** AEAD the evolved keys feed (matches Secure Transport). */
export const FS_CIPHER_ALGORITHM = "aes-256-gcm";
/** MAC the evolved keys feed. */
export const FS_MAC_ALGORITHM = "hmac-sha256";
/** Derivation namespace for the forward-secrecy chain. */
export const FS_NAMESPACE = "securechat-fs";
/** Version tag baked into every chain-evolution label (bump to rotate the scheme). */
export const FS_CHAIN_VERSION = 1;
/** The first cryptographic generation. */
export const INITIAL_GENERATION = 0;
/**
 * How many superseded generations keep their DERIVED keys for in-flight decryption
 * (the chain secret of a past generation is ALWAYS destroyed immediately — that is what
 * guarantees forward secrecy; this window only affects already-derived message keys).
 * `0` = strict FS (a superseded generation cannot decrypt at all).
 */
export const DEFAULT_RETAINED_GENERATIONS = 1;
/** Current FS metadata storage schema version. */
export const FS_SCHEMA_VERSION = 1;

/**
 * @typedef {object} GenerationRecord PUBLIC metadata for one generation (never keys).
 * @property {number} generation @property {string} keyId PUBLIC 32-hex identifier
 * @property {string} fingerprint PUBLIC key commitment
 * @property {string} algorithm @property {string} status one of {@link GenerationStatus}
 * @property {string} createdAt @property {string} [activatedAt] @property {string} [supersededAt] @property {string} [destroyedAt]
 * @property {string} [trigger] @property {string} [reason]
 */

/**
 * @typedef {object} DestructionRecord PUBLIC record that key material was wiped.
 * @property {string} scope e.g. "generation-keys" | "chain-secret" | "intermediate"
 * @property {number} [generation] @property {string} [keyId] @property {string} [fingerprint]
 * @property {string} reason one of {@link DestructionReason} @property {string} at ISO
 */

/**
 * @typedef {object} ForwardSecrecyState PUBLIC per-session FS metadata sidecar.
 * @property {string} sessionId @property {string} [handshakeId]
 * @property {boolean} started @property {number} currentGeneration
 * @property {GenerationRecord[]} generations @property {DestructionRecord[]} destructions
 * @property {object[]} audit @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */
