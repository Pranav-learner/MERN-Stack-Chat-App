/**
 * @module pdp/validators
 *
 * Validation for the Peer Discovery Protocol. Covers every spec item: unknown users, no active
 * devices, presence conflicts, capability conflicts, invalid selection, expired plans, malformed
 * metadata, and unauthorized discovery. Most runtime failures (no active devices, capability
 * conflicts, …) are raised by the {@link module:pdp/workflow workflow} as typed stage errors; this
 * module covers request/reference validation, ownership, expiry, and — most importantly — the
 * framework's core invariant:
 *
 * @security A PDP record or connection plan must NEVER carry secret material: no private key,
 * session key, message key, chain key, root key, MAC key, or shared secret.
 * {@link assertNoSecretMaterial} deep-scans for forbidden keys and is invoked before a plan is
 * stored or returned.
 */

import { ALL_PDP_STATES, ALL_SELECTION_POLICIES } from "../types/types.js";
import {
  PdpValidationError,
  PdpNotFoundError,
  PdpExpiredError,
  PlanExpiredError,
  UnauthorizedPdpError,
  CorruptedPlanError,
} from "../errors.js";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Field names that must NEVER appear anywhere in a PDP record / connection plan. */
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

/** Validate a discovery-session id's shape. @throws {PdpValidationError} */
export function validateDiscoveryId(discoveryId) {
  if (typeof discoveryId !== "string" || !ID_RE.test(discoveryId)) {
    throw new PdpValidationError("Invalid discovery identifier", { details: { discoveryId } });
  }
  return discoveryId;
}

/** Validate a plan id's shape. @throws {PdpValidationError} */
export function validatePlanId(planId) {
  if (typeof planId !== "string" || !ID_RE.test(planId)) {
    throw new PdpValidationError("Invalid plan identifier", { details: { planId } });
  }
  return planId;
}

/** Validate a user-id reference. @throws {PdpValidationError} */
export function validateUserRef(userId) {
  if (userId == null || typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new PdpValidationError("Invalid user identifier", { details: { userId } });
  }
  return userId;
}

/** Validate a device-id reference. @throws {PdpValidationError} */
export function validateDeviceRef(deviceId) {
  if (deviceId == null || typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    throw new PdpValidationError("Invalid device identifier", { details: { deviceId } });
  }
  return deviceId;
}

/** Validate a selection policy (falls back to default when omitted). @throws {PdpValidationError} */
export function validateSelectionPolicy(policy) {
  if (policy !== undefined && !ALL_SELECTION_POLICIES.includes(policy)) {
    throw new PdpValidationError(`Unknown selection policy "${policy}"`, { details: { policy, allowed: [...ALL_SELECTION_POLICIES] } });
  }
  return policy;
}

/**
 * Validate a raw start-discovery request before it reaches the manager.
 * @param {object} request @returns {object} the (unmodified) request @throws {PdpValidationError}
 */
export function validateStartRequest(request) {
  if (!request || typeof request !== "object") {
    throw new PdpValidationError("Malformed discovery request");
  }
  validateUserRef(request.requester);
  validateDeviceRef(request.requesterDevice);
  validateUserRef(request.targetUser);
  if (request.targetDevices !== undefined) {
    if (!Array.isArray(request.targetDevices)) {
      throw new PdpValidationError("targetDevices must be an array", { details: { targetDevices: request.targetDevices } });
    }
    request.targetDevices.forEach(validateDeviceRef);
  }
  validateSelectionPolicy(request.selectionPolicy);
  if (request.maxDevices !== undefined && (!Number.isInteger(request.maxDevices) || request.maxDevices <= 0)) {
    throw new PdpValidationError("maxDevices must be a positive integer", { details: { maxDevices: request.maxDevices } });
  }
  if (request.metadata !== undefined && (typeof request.metadata !== "object" || request.metadata === null || Array.isArray(request.metadata))) {
    throw new PdpValidationError("metadata must be a plain object", { details: { metadata: request.metadata } });
  }
  if (request.ttlMs !== undefined && (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)) {
    throw new PdpValidationError("ttlMs must be a positive number", { details: { ttlMs: request.ttlMs } });
  }
  return request;
}

/** Require a PDP session to exist. @throws {PdpNotFoundError} */
export function requirePdpSession(session, ref) {
  if (!session) throw new PdpNotFoundError("Discovery session not found", { details: { ref } });
  return session;
}

/** Require a connection plan to exist. @throws {PdpNotFoundError} */
export function requirePlan(plan, ref) {
  if (!plan) throw new PdpNotFoundError("Connection plan not found", { details: { ref } });
  return plan;
}

/** Assert a session has not expired. @throws {PdpExpiredError} */
export function assertSessionNotExpired(session, now = Date.now()) {
  if (session?.expiresAt && new Date(session.expiresAt).getTime() <= now && session.state !== "expired") {
    throw new PdpExpiredError("Discovery session has expired", { details: { discoveryId: session.discoveryId, expiresAt: session.expiresAt } });
  }
  return session;
}

/** Assert a plan has not expired. @throws {PlanExpiredError} */
export function assertPlanNotExpired(plan, now = Date.now()) {
  if (plan?.expiresAt && new Date(plan.expiresAt).getTime() <= now) {
    throw new PlanExpiredError("Connection plan has expired", { details: { planId: plan.planId, expiresAt: plan.expiresAt } });
  }
  return plan;
}

/**
 * Assert the acting user owns (is the requester of) a session/plan.
 * @param {object} record @param {string} actingUserId @throws {UnauthorizedPdpError}
 */
export function assertRequester(record, actingUserId) {
  if (!actingUserId || String(record.requester) !== String(actingUserId)) {
    throw new UnauthorizedPdpError("Caller is not the requester of this discovery", {
      details: { discoveryId: record.discoveryId, planId: record.planId },
    });
  }
  return record;
}

/**
 * Deep-scan an object graph for forbidden secret key material. The framework's core security
 * invariant. @param {any} value @param {string} [label] @throws {CorruptedPlanError}
 */
export function assertNoSecretMaterial(value, label = "connection plan") {
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
        throw new CorruptedPlanError(`${label} must not contain secret material ("${key}")`, {
          details: { key, path: `${path}.${key}` },
        });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/**
 * Validate a connection plan's shape (detects corruption/tampering + secret leakage).
 * @param {object} plan @throws {CorruptedPlanError}
 */
export function validateConnectionPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new CorruptedPlanError("Connection plan is not an object");
  }
  for (const field of ["planId", "requester", "targetUser", "selectedDevices", "primaryDeviceId"]) {
    if (plan[field] === undefined || plan[field] === null) {
      throw new CorruptedPlanError(`Connection plan is missing "${field}"`, { details: { field } });
    }
  }
  if (!Array.isArray(plan.selectedDevices) || plan.selectedDevices.length === 0) {
    throw new CorruptedPlanError("Connection plan has no selected devices");
  }
  assertNoSecretMaterial(plan, "connection plan");
  return plan;
}

/**
 * Validate a PDP session record's stored shape.
 * @param {object} session @throws {CorruptedPlanError}
 */
export function validatePdpSession(session) {
  if (!session || typeof session !== "object") throw new CorruptedPlanError("PDP session is not an object");
  for (const field of ["discoveryId", "requester", "targetUser", "state"]) {
    if (session[field] === undefined || session[field] === null) {
      throw new CorruptedPlanError(`PDP session is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_PDP_STATES.includes(session.state)) {
    throw new CorruptedPlanError(`Unknown PDP state: ${session.state}`, { details: { state: session.state } });
  }
  assertNoSecretMaterial(session, "PDP session");
  return session;
}

/** Validate a repository implements the required session-store contract. @throws {PdpValidationError} */
export function validateSessionRepository(repo, methods = ["create", "findById", "update", "delete", "findActiveByDedupeKey", "listByRequester", "listExpired"]) {
  if (!repo || typeof repo !== "object") throw new PdpValidationError("PDP session repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new PdpValidationError(`PDP session repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}

/** Validate a repository implements the required plan-store contract. @throws {PdpValidationError} */
export function validatePlanRepository(repo, methods = ["create", "findById", "findByDiscoveryId", "delete", "listByRequester"]) {
  if (!repo || typeof repo !== "object") throw new PdpValidationError("Connection plan repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new PdpValidationError(`Connection plan repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}
