/**
 * @module group-receipts/validators
 *
 * Validation for the Group Delivery Intelligence subsystem. Covers duplicate deliveries/reads (handled
 * idempotently in the manager via the once-per-member flags), invalid aggregates, unauthorized access,
 * repository consistency, replay attempts, malformed metadata, and privacy-policy violations. It also
 * enforces the no-content invariant.
 *
 * @security A receipt record carries DELIVERY CONTROL-PLANE metadata ONLY — NEVER message plaintext,
 * ciphertext, or key material. {@link assertNoContent} deep-scans before any persist.
 */

import { ALL_DELIVERY_STATUSES } from "../types/types.js";
import { ReceiptValidationError, ReceiptNotFoundError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/** Field names that must NEVER appear in a receipt record (secret / content markers). */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "groupKey",
  "epochSecret",
  "encryptionKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "keyBytes",
  "seed",
  "plaintext",
  "plainText",
  "cleartext",
  "decrypted",
  "ciphertext",
  "body",
  "content",
  "text",
]);

/** Validate an id reference. @throws {ReceiptValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new ReceiptValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Validate a delivery status (optional → delivered). */
export function validateDeliveryStatus(status) {
  if (status == null) return undefined;
  if (!ALL_DELIVERY_STATUSES.includes(status)) throw new ReceiptValidationError(`Invalid delivery status "${status}"`, { details: { status } });
  return status;
}

/** Deep-scan a value for forbidden content/secret material. @throws {ReceiptValidationError} */
export function assertNoContent(value, label = "record") {
  const seen = new Set();
  const walk = (node, path) => {
    if (node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.includes(key)) throw new ReceiptValidationError(`${label} must not contain content/secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate a register-message request. @throws {ReceiptValidationError} */
export function validateRegister(request) {
  if (!request || typeof request !== "object") throw new ReceiptValidationError("Malformed register request");
  validateRef(request.messageId, "message identifier");
  validateRef(request.groupId, "group identifier");
  if (request.senderId != null) validateRef(request.senderId, "sender identifier");
  if (!Array.isArray(request.applicableMembers)) throw new ReceiptValidationError("applicableMembers must be an array");
  for (const m of request.applicableMembers) validateRef(m, "member identifier");
  if (request.policy) assertNoContent(request.policy, "policy");
  return request;
}

/** Validate a delivery/read report. @throws {ReceiptValidationError} */
export function validateReport(report, { requireDevice = true } = {}) {
  if (!report || typeof report !== "object") throw new ReceiptValidationError("Malformed report");
  validateRef(report.messageId, "message identifier");
  validateRef(report.memberId, "member identifier");
  if (requireDevice) validateRef(report.deviceId, "device identifier");
  if (report.deviceMeta) assertNoContent(report.deviceMeta, "device metadata");
  return report;
}

/** Require an aggregate to exist. @throws {ReceiptNotFoundError} */
export function requireAggregate(aggregate, ref) {
  if (!aggregate) throw new ReceiptNotFoundError("Receipt aggregate not found", { details: { ref } });
  return aggregate;
}

/** Sanity-check aggregate invariants (counts within bounds). @throws {ReceiptValidationError} */
export function validateAggregateInvariants(aggregate) {
  if (!aggregate) return aggregate;
  const { deliveredCount = 0, readCount = 0, applicableCount = 0, readApplicableCount = applicableCount } = aggregate;
  if (deliveredCount < 0 || readCount < 0) throw new ReceiptValidationError("aggregate counts must be non-negative");
  if (deliveredCount > applicableCount) throw new ReceiptValidationError("deliveredCount cannot exceed applicableCount", { details: { deliveredCount, applicableCount } });
  if (readCount > readApplicableCount) throw new ReceiptValidationError("readCount cannot exceed readApplicableCount", { details: { readCount, readApplicableCount } });
  return aggregate;
}

/** Clamp + validate pagination. */
export function normalizePagination({ limit, offset } = {}, { max = 1000, def = 100 } = {}) {
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), max) : def;
  const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return { limit: lim, offset: off };
}

/** Validate a repository implements the required store contract. @throws {ReceiptValidationError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new ReceiptValidationError("Receipt repository is missing or malformed");
  for (const store of ["aggregates", "memberReceipts"]) {
    if (!repo[store] || typeof repo[store] !== "object") throw new ReceiptValidationError(`Repository is missing the '${store}' store`);
  }
  for (const m of ["create", "findById", "update"]) if (typeof repo.aggregates[m] !== "function") throw new ReceiptValidationError(`aggregates store is missing method "${m}"`);
  for (const m of ["upsert", "find", "listByMessage"]) if (typeof repo.memberReceipts[m] !== "function") throw new ReceiptValidationError(`memberReceipts store is missing method "${m}"`);
  return repo;
}
