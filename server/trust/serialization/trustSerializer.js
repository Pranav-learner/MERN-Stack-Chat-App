/**
 * @module trust/serialization
 *
 * Public DTOs for the trust API. Whitelists public verification fields (there is
 * no private material) and includes the effective state + any warnings.
 */

/**
 * @typedef {object} PublicVerificationDTO
 * @property {string} verificationId
 * @property {string} verifierUserId
 * @property {string} subjectUserId
 * @property {string} subjectIdentityId
 * @property {string} trustState stored trust state
 * @property {string} effectiveTrustState state after change/expiry evaluation
 * @property {boolean} isVerified convenience (effective ∈ {verified, trusted})
 * @property {string} verifiedFingerprint
 * @property {string} safetyNumber
 * @property {string} method
 * @property {Array<object>} warnings active trust warnings
 * @property {Array<object>} history
 * @property {string} verifiedAt
 * @property {string} lastCheckedAt
 * @property {object} metadata
 */

const VERIFIED_LIKE = new Set(["verified", "trusted"]);

/**
 * Shape a verification record into its public DTO.
 * @param {object} record
 * @param {{ effectiveState?: string, warnings?: object[] }} [context]
 * @returns {PublicVerificationDTO}
 */
export function toPublicVerification(record, context = {}) {
  const effective = context.effectiveState ?? record.trustState;
  return {
    verificationId: record.verificationId,
    verifierUserId: String(record.verifierUser),
    subjectUserId: String(record.subjectUser),
    subjectIdentityId: record.subjectIdentityId,
    trustState: record.trustState,
    effectiveTrustState: effective,
    isVerified: VERIFIED_LIKE.has(effective),
    verifiedFingerprint: record.verifiedFingerprint,
    safetyNumber: record.safetyNumber,
    method: record.method,
    warnings: context.warnings ?? [],
    history: record.history ?? [],
    verifiedAt: toIso(record.verifiedAt),
    lastCheckedAt: toIso(record.lastCheckedAt),
    metadata: record.metadata ?? {},
  };
}

/** Shape an identity-change log entry. */
export function toPublicChange(record) {
  return {
    subjectUserId: String(record.subjectUser),
    identityId: record.identityId,
    fromFingerprint: record.fromFingerprint,
    toFingerprint: record.toFingerprint,
    detectedByUserId: record.detectedByUser ? String(record.detectedByUser) : undefined,
    detectedAt: toIso(record.detectedAt),
  };
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
