/**
 * @module crypto-hardening/audit
 *
 * Security audit trail for the hardening subsystem. Records replay detections, lifecycle
 * verifications, recoveries, and alerts as an append-only, length-capped list.
 *
 * @security Audit entries carry METADATA ONLY. {@link assertNoSecretMaterial} rejects any
 * attempt to log key material.
 */

import { HardeningValidationError } from "../errors.js";

/** Audit action names. */
export const AuditAction = Object.freeze({
  REPLAY_DETECTED: "replay-detected",
  REPLAY_ACCEPTED: "replay-accepted",
  WINDOW_RESET: "replay-window-reset",
  LIFECYCLE_VERIFIED: "lifecycle-verified",
  LIFECYCLE_VIOLATION: "lifecycle-violation",
  RECOVERY: "recovery",
  ALERT: "alert-raised",
});

const FORBIDDEN = ["encryptionKey", "macKey", "chainKey", "messageKey", "rootKey", "chainSecret", "sharedSecret", "secret", "bytes", "keys"];

/** Throw if an object carries anything that looks like secret key material. */
export function assertNoSecretMaterial(details) {
  if (!details || typeof details !== "object") return details;
  for (const field of FORBIDDEN) {
    if (field in details) throw new HardeningValidationError(`Audit details must not contain "${field}"`, { details: { field } });
  }
  return details;
}

/**
 * Build an audit entry (metadata only).
 * @param {string} action @param {object} [meta]
 * @returns {object}
 */
export function auditEntry(action, meta = {}) {
  const entry = { action, at: meta.at ?? new Date().toISOString() };
  for (const field of ["sessionId", "generation", "messageNumber", "reason", "severity", "type"]) {
    if (meta[field] !== undefined) entry[field] = meta[field];
  }
  if (meta.details !== undefined) entry.details = assertNoSecretMaterial(meta.details);
  return entry;
}

/** Append an audit entry immutably, capping length. @returns {object[]} */
export function appendAudit(audit, entry, max = 1000) {
  const next = [...(audit ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
