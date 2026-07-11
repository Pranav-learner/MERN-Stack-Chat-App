/**
 * @module networking-hardening/validators
 *
 * Validation for the Networking Hardening subsystem — request/config shape guards + the no-secret
 * invariant (defence in depth: even metadata-only records are scanned before persistence).
 *
 * @security {@link assertNoSecretMaterial} deep-scans for forbidden key names and is invoked before
 * an alert/record is stored.
 */

import { AlertType, AlertSeverity } from "../types/types.js";
import { HardeningValidationError } from "../errors.js";

/** Field names that must NEVER appear in a hardening record. */
export const FORBIDDEN_SECRET_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "encryptionKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "ratchetKey",
  "keyBytes",
  "seed",
  "privateBytes",
]);

/** Validate an alert record's shape. @throws {HardeningValidationError} */
export function validateAlert(alert) {
  if (!alert || typeof alert !== "object") throw new HardeningValidationError("Alert is not an object");
  if (!Object.values(AlertType).includes(alert.alertType)) {
    throw new HardeningValidationError(`Unknown alert type "${alert.alertType}"`, { details: { alertType: alert.alertType } });
  }
  if (alert.severity && !Object.values(AlertSeverity).includes(alert.severity)) {
    throw new HardeningValidationError(`Unknown severity "${alert.severity}"`, { details: { severity: alert.severity } });
  }
  assertNoSecretMaterial(alert, "alert");
  return alert;
}

/** Validate a retry policy config. @throws {HardeningValidationError} */
export function validateRetryPolicy(policy) {
  if (policy === undefined) return policy;
  if (typeof policy !== "object" || policy === null) throw new HardeningValidationError("retryPolicy must be an object");
  if (policy.maxAttempts !== undefined && (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1)) {
    throw new HardeningValidationError("retryPolicy.maxAttempts must be a positive integer");
  }
  return policy;
}

/**
 * Deep-scan an object graph for forbidden secret key material. @param {any} value @param {string} [label]
 * @throws {HardeningValidationError}
 */
export function assertNoSecretMaterial(value, label = "hardening record") {
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
      if (FORBIDDEN_SECRET_KEYS.includes(key)) {
        throw new HardeningValidationError(`${label} must not contain secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate a repository implements the required alert-store contract. @throws {HardeningValidationError} */
export function validateRepository(repo, methods = ["record", "list", "count"]) {
  if (!repo || typeof repo !== "object") throw new HardeningValidationError("Hardening repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new HardeningValidationError(`Hardening repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}
