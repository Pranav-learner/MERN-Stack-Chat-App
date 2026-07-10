/**
 * @module forward-secrecy/audit
 *
 * Security **audit trail** for the Forward Secrecy Engine. Records notable, security-
 * relevant events — generation created/activated/destroyed, evolution completed/failed,
 * policy triggered, validation failure — as an append-only, length-capped list.
 *
 * @security Audit entries carry METADATA ONLY (generation numbers, key ids, fingerprints,
 * reasons, timestamps). {@link assertNoSecretMaterial} actively rejects any attempt to
 * log key bytes or secrets. Never pass raw key material into an audit entry.
 */

import { ForwardSecrecyValidationError } from "../errors.js";

/** Audit action names (stable, machine-readable). */
export const AuditAction = Object.freeze({
  STARTED: "forward-secrecy-started",
  GENERATION_CREATED: "generation-created",
  GENERATION_ACTIVATED: "generation-activated",
  GENERATION_DESTROYED: "generation-destroyed",
  KEYS_DESTROYED: "keys-destroyed",
  EVOLUTION_COMPLETED: "evolution-completed",
  EVOLUTION_FAILED: "evolution-failed",
  POLICY_TRIGGERED: "policy-triggered",
  VALIDATION_FAILURE: "validation-failure",
  SESSION_ENDED: "session-ended",
});

const FORBIDDEN_FIELDS = ["encryptionKey", "macKey", "chainSecret", "sharedSecret", "keys", "secret", "bytes", "initMaterial", "ratchetMaterial", "resumptionKey"];

/** Throw if an object carries anything that looks like secret key material. */
export function assertNoSecretMaterial(details) {
  if (!details || typeof details !== "object") return details;
  for (const field of FORBIDDEN_FIELDS) {
    if (field in details) {
      throw new ForwardSecrecyValidationError(`Audit details must not contain "${field}"`, { details: { field } });
    }
  }
  return details;
}

/**
 * Build a single audit entry (metadata only).
 * @param {string} action one of {@link AuditAction}
 * @param {{ at?: string, generation?: number, keyId?: string, fingerprint?: string, trigger?: string, reason?: string, actor?: string, details?: object }} [meta]
 * @returns {object}
 */
export function auditEntry(action, meta = {}) {
  const entry = { action, at: meta.at ?? new Date().toISOString() };
  for (const field of ["generation", "keyId", "fingerprint", "trigger", "reason", "actor"]) {
    if (meta[field] !== undefined) entry[field] = meta[field];
  }
  if (meta.details !== undefined) entry.details = assertNoSecretMaterial(meta.details);
  return entry;
}

/**
 * Append an audit entry immutably, capping length to bound record growth.
 * @param {object[]} audit @param {object} entry @param {number} [max=500] @returns {object[]}
 */
export function appendAudit(audit, entry, max = 500) {
  const next = [...(audit ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
