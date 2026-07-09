/**
 * @module trust/validators
 *
 * Validation for the trust layer: the trust-state machine, ownership, and input
 * shape checks. Fingerprint/key/QR validation is delegated to the fingerprint and
 * QR modules (which reuse Sprint 1 key validation).
 */

import { TrustState } from "../types.js";
import { InvalidTrustTransitionError, TrustValidationError, VerificationOwnershipError } from "../errors.js";

/**
 * Allowed transitions between stored trust states. `CHANGED` is additionally
 * settable by the system on identity-change detection (see the manager).
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [TrustState.UNKNOWN]: [TrustState.PENDING, TrustState.VERIFIED],
  [TrustState.PENDING]: [TrustState.VERIFIED, TrustState.REVOKED, TrustState.BLOCKED],
  [TrustState.VERIFIED]: [
    TrustState.TRUSTED,
    TrustState.CHANGED,
    TrustState.REVOKED,
    TrustState.BLOCKED,
    TrustState.COMPROMISED,
    TrustState.EXPIRED,
    TrustState.PENDING,
  ],
  [TrustState.TRUSTED]: [
    TrustState.VERIFIED,
    TrustState.CHANGED,
    TrustState.REVOKED,
    TrustState.BLOCKED,
    TrustState.COMPROMISED,
    TrustState.EXPIRED,
  ],
  [TrustState.CHANGED]: [TrustState.PENDING, TrustState.VERIFIED, TrustState.REVOKED, TrustState.BLOCKED],
  [TrustState.EXPIRED]: [TrustState.PENDING, TrustState.VERIFIED, TrustState.REVOKED],
  [TrustState.BLOCKED]: [TrustState.REVOKED, TrustState.PENDING],
  [TrustState.COMPROMISED]: [TrustState.REVOKED],
  [TrustState.REVOKED]: [TrustState.PENDING, TrustState.VERIFIED],
});

/**
 * Whether a trust-state transition is legal.
 * @param {string} from @param {string} to @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Assert a trust-state transition is legal.
 * @throws {InvalidTrustTransitionError}
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidTrustTransitionError(`Cannot transition trust from "${from}" to "${to}"`, {
      details: { from, to },
    });
  }
}

/**
 * Assert a verification record belongs to the given verifier.
 * @throws {VerificationOwnershipError}
 */
export function assertOwnership(record, verifierUser) {
  if (String(record.verifierUser) !== String(verifierUser)) {
    throw new VerificationOwnershipError();
  }
}

/**
 * Validate a verify request's basic shape (cannot self-verify; ids present).
 * @param {{ verifierUser: string, subjectUser: string }} input
 * @throws {TrustValidationError}
 */
export function validateVerifyRequest({ verifierUser, subjectUser }) {
  if (!verifierUser || !subjectUser) {
    throw new TrustValidationError("verifierUser and subjectUser are required");
  }
  if (String(verifierUser) === String(subjectUser)) {
    throw new TrustValidationError("A user cannot verify their own identity");
  }
}
