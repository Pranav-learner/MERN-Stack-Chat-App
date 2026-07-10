/**
 * @module key-hierarchy/audit
 *
 * Security audit trail for the key hierarchy. Records root-key + chain lifecycle events as
 * an append-only, length-capped list.
 *
 * @security Audit entries carry METADATA ONLY (key ids, fingerprints, generations, chain
 * indexes, reasons, timestamps). {@link assertNoSecretMaterial} rejects any attempt to log
 * key material.
 */

import { KeyHierarchyValidationError } from "../errors.js";

/** Audit action names (stable, machine-readable). */
export const AuditAction = Object.freeze({
  ROOT_CREATED: "root-key-created",
  ROOT_SUPERSEDED: "root-key-superseded",
  CHAIN_CREATED: "chain-created",
  CHAIN_ADVANCED: "chain-advanced",
  CHAIN_ARCHIVED: "chain-archived",
  CHAIN_VALIDATED: "chain-validated",
  HIERARCHY_DESTROYED: "hierarchy-destroyed",
});

const FORBIDDEN = ["rootKey", "chainKey", "sendingKey", "receivingKey", "secret", "bytes", "key", "keys", "sharedSecret", "ratchetMaterial"];

/** Throw if an object carries anything that looks like secret key material. */
export function assertNoSecretMaterial(details) {
  if (!details || typeof details !== "object") return details;
  for (const field of FORBIDDEN) {
    if (field in details) throw new KeyHierarchyValidationError(`Audit details must not contain "${field}"`, { details: { field } });
  }
  return details;
}

/**
 * Build an audit entry (metadata only).
 * @param {string} action one of {@link AuditAction}
 * @param {{ at?: string, generation?: number, rootKeyId?: string, chainId?: string, direction?: string, role?: string, index?: number, fingerprint?: string, reason?: string, details?: object }} [meta]
 * @returns {object}
 */
export function auditEntry(action, meta = {}) {
  const entry = { action, at: meta.at ?? new Date().toISOString() };
  for (const field of ["generation", "rootKeyId", "chainId", "direction", "role", "index", "fingerprint", "reason"]) {
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
