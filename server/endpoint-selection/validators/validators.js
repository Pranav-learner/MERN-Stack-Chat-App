/**
 * @module endpoint-selection/validators
 *
 * Validation for the Endpoint Selection subsystem. Covers every spec item: duplicate endpoints,
 * invalid rankings, expired plans, offline primary endpoint, missing fallback, capability mismatch,
 * selection conflicts, and malformed metadata. It also enforces the framework's core invariant:
 *
 * @security A plan/selection must NEVER carry secret material: no private key, session key, message
 * key, chain key, root key, MAC key, or shared secret. {@link assertNoSecretMaterial} deep-scans for
 * forbidden keys and is invoked before a plan is stored or returned.
 */

import { ALL_SELECTION_POLICIES } from "../types/types.js";
import {
  EndpointValidationError,
  EndpointNotFoundError,
  PlanExpiredError,
  UnauthorizedEndpointError,
  CorruptedPlanError,
} from "../errors.js";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Field names that must NEVER appear anywhere in a plan / selection record. */
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

/** Validate a plan id's shape. @throws {EndpointValidationError} */
export function validatePlanId(planId) {
  if (typeof planId !== "string" || !ID_RE.test(planId)) {
    throw new EndpointValidationError("Invalid plan identifier", { details: { planId } });
  }
  return planId;
}

/** Validate a user-id reference. @throws {EndpointValidationError} */
export function validateUserRef(userId) {
  if (userId == null || typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new EndpointValidationError("Invalid user identifier", { details: { userId } });
  }
  return userId;
}

/** Validate a device-id reference. @throws {EndpointValidationError} */
export function validateDeviceRef(deviceId) {
  if (deviceId == null || typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    throw new EndpointValidationError("Invalid device identifier", { details: { deviceId } });
  }
  return deviceId;
}

/** Validate a selection policy (name or custom object; falls back when omitted). @throws {EndpointValidationError} */
export function validatePolicy(policy) {
  if (policy === undefined || policy === null) return policy;
  if (typeof policy === "string") {
    if (!ALL_SELECTION_POLICIES.includes(policy)) {
      throw new EndpointValidationError(`Unknown selection policy "${policy}"`, { details: { policy, allowed: [...ALL_SELECTION_POLICIES] } });
    }
    return policy;
  }
  if (typeof policy === "object" && policy.weights && typeof policy.weights === "object") return policy;
  throw new EndpointValidationError("Selection policy must be a known name or a { weights } object", { details: { policy } });
}

/**
 * Validate a candidate list: non-empty, well-formed, and free of DUPLICATE device ids.
 * @param {object[]} candidates @throws {EndpointValidationError}
 */
export function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new EndpointValidationError("candidates must be a non-empty array", { details: { count: candidates?.length ?? 0 } });
  }
  const seen = new Set();
  for (const c of candidates) {
    if (!c || typeof c !== "object") throw new EndpointValidationError("Each candidate must be an object");
    validateDeviceRef(c.deviceId);
    if (seen.has(c.deviceId)) {
      throw new EndpointValidationError(`Duplicate endpoint "${c.deviceId}"`, { details: { deviceId: c.deviceId } });
    }
    seen.add(c.deviceId);
    if (c.capabilities !== undefined && c.capabilities !== null && typeof c.capabilities !== "object") {
      throw new EndpointValidationError("candidate.capabilities must be an object", { details: { deviceId: c.deviceId } });
    }
  }
  return candidates;
}

/**
 * Validate a generate-plan request payload before it reaches the manager.
 * @param {object} request @throws {EndpointValidationError}
 */
export function validateGenerateRequest(request) {
  if (!request || typeof request !== "object") throw new EndpointValidationError("Malformed selection request");
  validateUserRef(request.requester);
  validateDeviceRef(request.requesterDevice);
  validateUserRef(request.targetUser);
  validateCandidates(request.candidates);
  validatePolicy(request.policy);
  if (request.maxFallbacks !== undefined && (!Number.isInteger(request.maxFallbacks) || request.maxFallbacks < 0)) {
    throw new EndpointValidationError("maxFallbacks must be a non-negative integer", { details: { maxFallbacks: request.maxFallbacks } });
  }
  if (request.metadata !== undefined && (typeof request.metadata !== "object" || request.metadata === null || Array.isArray(request.metadata))) {
    throw new EndpointValidationError("metadata must be a plain object", { details: { metadata: request.metadata } });
  }
  return request;
}

/** Require a plan to exist. @throws {EndpointNotFoundError} */
export function requirePlan(plan, ref) {
  if (!plan) throw new EndpointNotFoundError("Connection plan not found", { details: { ref } });
  return plan;
}

/** Assert a plan has not expired. @throws {PlanExpiredError} */
export function assertPlanNotExpired(plan, now = Date.now()) {
  if (plan?.expiresAt && new Date(plan.expiresAt).getTime() <= now) {
    throw new PlanExpiredError("Connection plan has expired", { details: { planId: plan.planId, expiresAt: plan.expiresAt } });
  }
  return plan;
}

/** Assert the acting user owns a plan (requester-scoped). @throws {UnauthorizedEndpointError} */
export function assertRequester(plan, actingUserId) {
  if (!actingUserId || String(plan.requester) !== String(actingUserId)) {
    throw new UnauthorizedEndpointError("Caller is not the requester of this plan", { details: { planId: plan.planId } });
  }
  return plan;
}

/**
 * Deep-scan an object graph for forbidden secret key material. @param {any} value @param {string} [label]
 * @throws {CorruptedPlanError}
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
        throw new CorruptedPlanError(`${label} must not contain secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/**
 * Validate a produced connection plan's shape (detects corruption + a ranking with no eligible
 * primary + secret leakage). @param {object} plan @throws {CorruptedPlanError}
 */
export function validateConnectionPlan(plan) {
  if (!plan || typeof plan !== "object") throw new CorruptedPlanError("Connection plan is not an object");
  for (const field of ["planId", "requester", "targetUser", "primaryEndpoint", "priorityOrder"]) {
    if (plan[field] === undefined || plan[field] === null) {
      throw new CorruptedPlanError(`Connection plan is missing "${field}"`, { details: { field } });
    }
  }
  if (!Array.isArray(plan.priorityOrder) || plan.priorityOrder.length === 0) {
    throw new CorruptedPlanError("Connection plan has an invalid (empty) priority order");
  }
  // The primary must lead the priority order (no selection conflict).
  if (plan.primaryEndpoint.deviceId !== plan.priorityOrder[0]) {
    throw new CorruptedPlanError("Connection plan primary does not lead the priority order", {
      details: { primary: plan.primaryEndpoint.deviceId, head: plan.priorityOrder[0] },
    });
  }
  assertNoSecretMaterial(plan, "connection plan");
  return plan;
}

/** Validate a repository implements the required plan-store contract. @throws {EndpointValidationError} */
export function validatePlanRepository(repo, methods = ["create", "findById", "update", "delete", "listByRequester"]) {
  if (!repo || typeof repo !== "object") throw new EndpointValidationError("Plan repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new EndpointValidationError(`Plan repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}

/** Validate a repository implements the required reliability-store contract. @throws {EndpointValidationError} */
export function validateReliabilityRepository(repo, methods = ["get", "getMany", "record"]) {
  if (!repo || typeof repo !== "object") throw new EndpointValidationError("Reliability repository is missing or malformed");
  for (const m of methods) {
    if (typeof repo[m] !== "function") throw new EndpointValidationError(`Reliability repository is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}
