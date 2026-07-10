/**
 * @module message-keys/types
 *
 * Enums and type declarations for the **Per-Message Key** subsystem (Layer 5, Sprint 5).
 * Every encrypted message now uses its own unique cryptographic key, deterministically
 * derived from the active sending/receiving chain (Sprint 4 key hierarchy) and **securely
 * destroyed immediately after use**.
 *
 * ## Model
 * At chain index `n` (chain key `CKₙ`), the message key is `MKₙ = HKDF(CKₙ, "msg|dir|gen|n")`
 * — an INDEPENDENT derivation from the same `CKₙ` the chain-advance ratchet consumes, so the
 * message key and the next chain key are cryptographically unrelated. `MKₙ` encrypts (or
 * decrypts) exactly one message, then is wiped; the chain then advances to `CKₙ₊₁`.
 *
 * @security This IS a cryptographic module. Message keys are SECRET, device-local, and
 * **ephemeral** — they exist only for the duration of one encrypt/decrypt and are then
 * zero-filled. They are NEVER serialized, persisted, logged, or returned by an API.
 * Repositories + DTOs + events + audit records carry METADATA only (message numbers, key
 * ids, fingerprints, generations, delivery status, timestamps).
 *
 * @out-of-scope Double Ratchet + Post-Compromise Security (Sprint 6+). This sprint derives
 * per-message keys from the EXISTING chains; it does not add a DH ratchet.
 */

/**
 * Lifecycle state of a single message key.
 * - `DERIVED`   — derived from the chain key; not yet used (transient).
 * - `ACTIVE`    — currently in use for one encrypt/decrypt.
 * - `USED`      — the single encrypt/decrypt completed (metadata retained; key wiped).
 * - `DESTROYED` — key bytes zero-filled (terminal).
 * - `CACHED`    — a skipped (out-of-order) key retained for a later message (still secret).
 * - `EXPIRED`   — a cached key aged out and was destroyed.
 * - `FAILED`    — derivation/use failed; the key was wiped.
 * @readonly @enum {string}
 */
export const MessageKeyState = Object.freeze({
  DERIVED: "derived",
  ACTIVE: "active",
  USED: "used",
  DESTROYED: "destroyed",
  CACHED: "cached",
  EXPIRED: "expired",
  FAILED: "failed",
});

/** The direction a message key belongs to (relative to THIS device). */
export const MessageDirection = Object.freeze({
  SENDING: "sending",
  RECEIVING: "receiving",
});

/** Delivery status recorded on message metadata. */
export const DeliveryStatus = Object.freeze({
  ENCRYPTED: "encrypted",
  DECRYPTED: "decrypted",
  FAILED: "failed",
});

/**
 * Message-key event types. Future layers consume these.
 * @readonly @enum {string}
 */
export const MessageKeyEventType = Object.freeze({
  MESSAGE_KEY_DERIVED: "mk.derived",
  MESSAGE_ENCRYPTED: "mk.message_encrypted",
  MESSAGE_DECRYPTED: "mk.message_decrypted",
  MESSAGE_KEY_DESTROYED: "mk.destroyed",
  MESSAGE_KEY_CACHED: "mk.cached",
  MESSAGE_KEY_EXPIRED: "mk.expired",
  CHAIN_ADVANCED: "mk.chain_advanced",
  DERIVATION_FAILED: "mk.derivation_failed",
  VALIDATION_FAILED: "mk.validation_failed",
});

/**
 * Machine-readable failure reasons.
 * @readonly @enum {string}
 */
export const MessageKeyFailureReason = Object.freeze({
  UNKNOWN_SESSION: "unknown-session",
  DUPLICATE_NUMBER: "duplicate-message-number",
  CHAIN_MISMATCH: "chain-mismatch",
  MISSING_CHAIN: "missing-chain",
  GENERATION_MISMATCH: "generation-mismatch",
  INVALID_DERIVATION: "invalid-derivation",
  DESTROYED_KEY_REUSE: "destroyed-key-reuse",
  MALFORMED_METADATA: "malformed-metadata",
  REPLAY: "replay",
  TOO_MANY_SKIPPED: "too-many-skipped",
  KEYSTORE_REQUIRED: "keystore-required",
  INTERNAL_ERROR: "internal-error",
});

/** KDF used for message keys (matches the rest of Layer 4/5). */
export const MK_KDF = "hkdf-sha256";
/** Byte length of the derived encryption + MAC keys. */
export const MK_KEY_BYTES = 32;
/** Derivation namespace for message keys. */
export const MK_NAMESPACE = "securechat-mk";
/** Scheme version baked into derivation labels. */
export const MK_VERSION = 1;
/** Max out-of-order gap the receiver will skip-derive in one step (DoS guard). */
export const DEFAULT_MAX_SKIP = 1000;
/** Max skipped-message keys cached per session before the oldest are destroyed. */
export const DEFAULT_CACHE_LIMIT = 2000;
/** Default TTL for a cached skipped key (ms) before it expires + is destroyed. */
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
/** Envelope version for the message-key transport wrapper. */
export const MK_ENVELOPE_VERSION = 1;
/** Current message-metadata storage schema version. */
export const MK_SCHEMA_VERSION = 1;

/**
 * @typedef {object} MessageKeyBundle DEVICE-LOCAL, EPHEMERAL secret key material for ONE
 *   message. Never serialized; wiped immediately after use.
 * @property {Buffer} encryptionKey 32 bytes @property {Buffer} macKey 32 bytes
 * @property {string} keyId PUBLIC unique id @property {string} keyFingerprint PUBLIC commitment
 * @property {number} messageNumber @property {string} direction @property {number} generation
 */

/**
 * @typedef {object} MessageMeta PUBLIC per-message metadata (never key bytes).
 * @property {string} messageId @property {string} sessionId @property {string} direction
 * @property {number} generation @property {number} messageNumber
 * @property {string} keyId @property {string} fingerprint @property {string} state
 * @property {string} delivery @property {string} at
 */

/**
 * @typedef {object} MessageKeyState_ PUBLIC per-session message-key sidecar (metadata only).
 * @property {string} sessionId @property {string} [handshakeId] @property {number} generation
 * @property {{ count: number, lastNumber: number }} sending
 * @property {{ count: number, lastNumber: number, highestNumber: number }} receiving
 * @property {MessageMeta[]} messages (capped) @property {object[]} audit
 * @property {object} metadata @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */
