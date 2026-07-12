/**
 * @module fabric-reliability/validators
 *
 * Validation for the **Production Communication Fabric** reliability layer (STEP 14 across sprints). Covers
 * invalid operations, configuration errors, repository consistency, checkpoint consistency, and the
 * platform-wide no-content invariant.
 *
 * @security The reliability layer is a control-plane wrapper: every persisted record carries ids +
 * classifications + numbers only. {@link assertNoContent} deep-scans before any persist.
 */

import { ReliabilityContentLeakError, InvalidOperationError, ReliabilityRepositoryError, ReliabilityConfigurationError } from "../errors.js";
import { ALL_OPERATION_KINDS, ALL_OPERATION_STATES } from "../types/types.js";

const ID_RE = /^[A-Za-z0-9_.:#@\-/]{1,200}$/;
const KIND_SET = new Set(ALL_OPERATION_KINDS);
const STATE_SET = new Set(ALL_OPERATION_STATES);

/** Field names that must NEVER appear in a reliability control-plane record. */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey", "secretKey", "sharedSecret", "sessionKey", "groupKey", "epochSecret", "encryptionKey",
  "macKey", "messageKey", "chainKey", "rootKey", "keyBytes", "seed", "plaintext", "plainText", "cleartext",
  "decrypted", "ciphertext", "body", "content", "text", "message", "bytes", "buffer", "blob",
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_KEYS.map((k) => k.toLowerCase()));

/** Deep-scan for forbidden content/secret keys. @throws {ReliabilityContentLeakError} */
export function assertNoContent(obj, { path = "", depth = 0 } = {}) {
  if (obj == null || typeof obj !== "object" || depth > 8) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoContent(v, { path: `${path}[${i}]`, depth: depth + 1 }));
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (FORBIDDEN_SET.has(key.toLowerCase())) throw new ReliabilityContentLeakError(`Forbidden content/secret field "${key}"`, { details: { path: `${path}.${key}` } });
    assertNoContent(val, { path: `${path}.${key}`, depth: depth + 1 });
  }
}

/** Validate an id reference. */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new InvalidOperationError(`Invalid ${label}`, { details: { value: id } });
  return id;
}

/** Validate an operation kind. @throws {InvalidOperationError} */
export function validateOperationKind(kind) {
  if (!KIND_SET.has(kind)) throw new InvalidOperationError(`Unknown operation kind "${kind}"`, { details: { kind } });
  return kind;
}

/** Validate a checkpoint's shape/state. */
export function validateCheckpoint(cp) {
  if (!cp || typeof cp !== "object") throw new InvalidOperationError("Checkpoint must be an object");
  validateRef(cp.operationId, "operationId");
  validateOperationKind(cp.kind);
  if (cp.state != null && !STATE_SET.has(cp.state)) throw new InvalidOperationError(`Unknown operation state "${cp.state}"`, { details: { state: cp.state } });
  assertNoContent(cp);
  return cp;
}

/** Validate the repository bundle. @throws {ReliabilityRepositoryError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new ReliabilityRepositoryError("Repository bundle is required");
  const contracts = {
    operations: ["upsert", "findById", "listActive"],
    health: ["recordSnapshot", "latest"],
    audit: ["append", "listByOperation"],
  };
  for (const [store, methods] of Object.entries(contracts)) {
    if (!repo[store] || typeof repo[store] !== "object") throw new ReliabilityRepositoryError(`Repository is missing the "${store}" store`, { details: { store } });
    for (const m of methods) if (typeof repo[store][m] !== "function") throw new ReliabilityRepositoryError(`Repository store "${store}" is missing "${m}"`, { details: { store, method: m } });
  }
  return repo;
}

/** Validate config (circuit/retry/timeout/bulkhead/recovery numeric bounds). @throws {ReliabilityConfigurationError} */
export function validateConfig(config = {}) {
  if (typeof config !== "object") throw new ReliabilityConfigurationError("Config must be an object");
  const positive = (v, name) => {
    if (v != null && (typeof v !== "number" || v < 0)) throw new ReliabilityConfigurationError(`${name} must be a non-negative number`);
  };
  positive(config.circuit?.failureThreshold, "circuit.failureThreshold");
  positive(config.retry?.maxAttempts, "retry.maxAttempts");
  positive(config.timeout?.defaultMs, "timeout.defaultMs");
  positive(config.bulkhead?.maxConcurrent, "bulkhead.maxConcurrent");
  positive(config.recovery?.recoveryTimeoutMs, "recovery.recoveryTimeoutMs");
  return config;
}
