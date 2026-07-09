/**
 * @module trust/types
 *
 * Enums and type declarations for the Trust subsystem (Layer 3, Sprint 3 —
 * user-to-user identity verification). Frozen objects act as enums in plain JS.
 */

/**
 * Trust states for a verification relationship (verifier → subject).
 *
 * - `UNKNOWN`     — no verification exists (computed default).
 * - `PENDING`     — verification initiated, not yet confirmed.
 * - `VERIFIED`    — verifier confirmed the subject's fingerprint/safety number.
 * - `TRUSTED`     — verified and explicitly elevated to trusted.
 * - `CHANGED`     — the subject's identity key changed since verification (warning).
 * - `COMPROMISED` — flagged compromised.
 * - `REVOKED`     — verification revoked by the verifier.
 * - `EXPIRED`     — verification older than the freshness window.
 * - `BLOCKED`     — the subject identity is blocked by the verifier.
 * @readonly @enum {string}
 */
export const TrustState = Object.freeze({
  UNKNOWN: "unknown",
  PENDING: "pending",
  VERIFIED: "verified",
  TRUSTED: "trusted",
  CHANGED: "changed",
  COMPROMISED: "compromised",
  REVOKED: "revoked",
  EXPIRED: "expired",
  BLOCKED: "blocked",
});

/** Stored verification states (excludes the computed `UNKNOWN`). */
export const STORED_TRUST_STATES = Object.freeze([
  TrustState.PENDING,
  TrustState.VERIFIED,
  TrustState.TRUSTED,
  TrustState.CHANGED,
  TrustState.COMPROMISED,
  TrustState.REVOKED,
  TrustState.EXPIRED,
  TrustState.BLOCKED,
]);

/** How a verification was performed. @readonly @enum {string} */
export const VerificationMethod = Object.freeze({
  MANUAL: "manual",
  SAFETY_NUMBER: "safety-number",
  QR: "qr",
  FINGERPRINT: "fingerprint",
});

/** Internal trust event types. Future layers subscribe. @readonly @enum {string} */
export const TrustEventType = Object.freeze({
  IDENTITY_VERIFIED: "trust.identity_verified",
  IDENTITY_CHANGED: "trust.identity_changed",
  VERIFICATION_REVOKED: "trust.verification_revoked",
  FINGERPRINT_CHANGED: "trust.fingerprint_changed",
  TRUST_UPDATED: "trust.trust_updated",
  SAFETY_NUMBER_GENERATED: "trust.safety_number_generated",
  QR_PAYLOAD_GENERATED: "trust.qr_payload_generated",
});

/** Trust warning categories surfaced to users / future layers. @readonly @enum {string} */
export const TrustWarningType = Object.freeze({
  IDENTITY_CHANGED: "identity-changed",
  FINGERPRINT_CHANGED: "fingerprint-changed",
  DEVICE_ADDED: "device-added",
  UNKNOWN_IDENTITY: "unknown-identity",
  SAFETY_NUMBER_MISMATCH: "safety-number-mismatch",
  KEY_ROTATION: "key-rotation",
});

/**
 * @typedef {object} Verification
 * @property {string} verificationId
 * @property {string} verifierUser the user performing verification
 * @property {string} subjectUser the user being verified
 * @property {string} subjectIdentityId
 * @property {string} verifiedPublicKey subject's identity public key at verification time (base64)
 * @property {string} verifiedFingerprint subject's fingerprint at verification time (hex)
 * @property {string} safetyNumber pairwise safety number at verification time
 * @property {TrustState} trustState
 * @property {VerificationMethod} method
 * @property {string[]} [verifiedDeviceFingerprints]
 * @property {string} verifiedAt ISO
 * @property {string} lastCheckedAt ISO
 * @property {Array<{ event: string, at: string, fromFingerprint?: string, toFingerprint?: string }>} history
 * @property {object} metadata
 * @property {string} createdAt
 * @property {string} updatedAt
 */
