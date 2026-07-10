/**
 * @module crypto-hardening/validators
 *
 * Validation helpers for the hardening subsystem — replay contexts, alert shapes, and
 * repository contracts.
 */

import { HardeningValidationError } from "../errors.js";
import { AlertType, AlertSeverity } from "../types/types.js";

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate a session-id reference. @throws {HardeningValidationError} */
export function validateSessionRef(sessionId) {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) {
    throw new HardeningValidationError("Invalid session identifier", { details: { sessionId } });
  }
  return sessionId;
}

/** Validate a replay context's shape. @throws {HardeningValidationError} */
export function validateReplayContext(ctx) {
  if (!ctx || typeof ctx !== "object") throw new HardeningValidationError("Malformed replay context");
  validateSessionRef(ctx.sessionId);
  if (!Number.isInteger(ctx.generation) || ctx.generation < 0) throw new HardeningValidationError("Invalid generation", { details: { generation: ctx.generation } });
  if (!Number.isInteger(ctx.messageNumber) || ctx.messageNumber < 0) throw new HardeningValidationError("Invalid message number", { details: { messageNumber: ctx.messageNumber } });
  return ctx;
}

/** Validate an alert's shape. @throws {HardeningValidationError} */
export function validateAlert(alert) {
  if (!alert || typeof alert !== "object") throw new HardeningValidationError("Malformed alert");
  if (!Object.values(AlertType).includes(alert.type)) throw new HardeningValidationError(`Unknown alert type "${alert.type}"`);
  if (!Object.values(AlertSeverity).includes(alert.severity)) throw new HardeningValidationError(`Unknown alert severity "${alert.severity}"`);
  return alert;
}

/** Validate a repository implements the required contract. @throws {HardeningValidationError} */
export function validateRepository(repo, methods = ["record", "list", "listBySession"]) {
  if (!repo || typeof repo !== "object") throw new HardeningValidationError("Hardening repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new HardeningValidationError(`Hardening repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}
