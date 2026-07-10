/**
 * @module evolution-policy/audit
 *
 * Security audit trail for the automatic-rekey engine. Records policy configuration,
 * evaluation, and every rekey execution transition as an append-only, length-capped list.
 *
 * @security Audit entries carry METADATA ONLY (session/execution ids, generation numbers,
 * policy ids/types, triggers, reasons, timestamps). {@link assertNoSecretMaterial} rejects
 * any attempt to log key material.
 */

import { RekeyValidationError } from "../errors.js";
import { DEFAULT_HISTORY_LIMIT } from "../types/types.js";

/** Audit action names (stable, machine-readable). */
export const AuditAction = Object.freeze({
  CONFIGURED: "policy-configured",
  POLICY_ATTACHED: "policy-attached",
  POLICY_REMOVED: "policy-removed",
  EVALUATED: "policy-evaluated",
  TRIGGERED: "policy-triggered",
  REKEY_QUEUED: "rekey-queued",
  REKEY_STARTED: "rekey-started",
  REKEY_COMPLETED: "rekey-completed",
  REKEY_FAILED: "rekey-failed",
  REKEY_RETRY: "rekey-retry",
  REKEY_CANCELLED: "rekey-cancelled",
});

const FORBIDDEN = ["encryptionKey", "macKey", "chainSecret", "sharedSecret", "keys", "secret", "bytes", "rootSecret"];

/** Throw if an object carries anything that looks like secret key material. */
export function assertNoSecretMaterial(details) {
  if (!details || typeof details !== "object") return details;
  for (const field of FORBIDDEN) {
    if (field in details) throw new RekeyValidationError(`Audit details must not contain "${field}"`, { details: { field } });
  }
  return details;
}

/**
 * Build an audit entry (metadata only).
 * @param {string} action one of {@link AuditAction}
 * @param {{ at?: string, executionId?: string, generation?: number, policyId?: string, policyType?: string, trigger?: string, reason?: string, details?: object }} [meta]
 * @returns {object}
 */
export function auditEntry(action, meta = {}) {
  const entry = { action, at: meta.at ?? new Date().toISOString() };
  for (const field of ["executionId", "generation", "policyId", "policyType", "trigger", "reason"]) {
    if (meta[field] !== undefined) entry[field] = meta[field];
  }
  if (meta.details !== undefined) entry.details = assertNoSecretMaterial(meta.details);
  return entry;
}

/** Append an audit entry immutably, capping length. @returns {object[]} */
export function appendAudit(audit, entry, max = DEFAULT_HISTORY_LIMIT) {
  const next = [...(audit ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
