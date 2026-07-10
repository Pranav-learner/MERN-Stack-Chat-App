/**
 * @module message-keys/audit
 *
 * Security audit trail for the per-message key engine. Records derivation, use, destruction,
 * caching, and failures as an append-only, length-capped list.
 *
 * @security Audit entries carry METADATA ONLY (message numbers, key ids, fingerprints,
 * generations, directions, reasons, timestamps). {@link assertNoSecretMaterial} rejects any
 * attempt to log key material.
 */

import { MessageKeyValidationError } from "../errors.js";

/** Audit action names (stable, machine-readable). */
export const AuditAction = Object.freeze({
  DERIVED: "message-key-derived",
  ENCRYPTED: "message-encrypted",
  DECRYPTED: "message-decrypted",
  DESTROYED: "message-key-destroyed",
  CACHED: "message-key-cached",
  EXPIRED: "message-key-expired",
  DERIVATION_FAILED: "derivation-failed",
  VALIDATION_FAILED: "validation-failed",
});

const FORBIDDEN = ["encryptionKey", "macKey", "chainKey", "messageKey", "secret", "bytes", "key", "keys"];

/** Throw if an object carries anything that looks like secret key material. */
export function assertNoSecretMaterial(details) {
  if (!details || typeof details !== "object") return details;
  for (const field of FORBIDDEN) {
    if (field in details) throw new MessageKeyValidationError(`Audit details must not contain "${field}"`, { details: { field } });
  }
  return details;
}

/**
 * Build an audit entry (metadata only).
 * @param {string} action one of {@link AuditAction}
 * @param {{ at?: string, direction?: string, generation?: number, messageNumber?: number, keyId?: string, fingerprint?: string, reason?: string, details?: object }} [meta]
 * @returns {object}
 */
export function auditEntry(action, meta = {}) {
  const entry = { action, at: meta.at ?? new Date().toISOString() };
  for (const field of ["direction", "generation", "messageNumber", "keyId", "fingerprint", "reason"]) {
    if (meta[field] !== undefined) entry[field] = meta[field];
  }
  if (meta.details !== undefined) entry.details = assertNoSecretMaterial(meta.details);
  return entry;
}

/** Append an audit entry immutably, capping length. @returns {object[]} */
export function appendAudit(audit, entry, max = 500) {
  const next = [...(audit ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
