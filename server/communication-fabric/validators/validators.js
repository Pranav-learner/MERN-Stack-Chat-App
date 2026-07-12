/**
 * @module communication-fabric/validators
 *
 * Validation for the **Communication Fabric** (STEP 14). Covers every failure mode the sprint enumerates:
 * invalid request/context, unknown strategy, missing policy, invalid decision, execution-plan
 * consistency, repository consistency, unauthorized operations, configuration errors, unsupported
 * (deferred) communication types, AND the platform-wide no-content invariant.
 *
 * @security The Fabric is a control-plane orchestrator: a fabric record must carry ids + classifications +
 * bookkeeping ONLY. {@link assertNoContent} deep-scans any object about to be persisted for forbidden
 * secret/content markers and rejects it, so plaintext / ciphertext / key material can never leak into a
 * decision, plan, or audit record.
 */

import {
  InvalidRequestError,
  InvalidContextError,
  InvalidDecisionError,
  InvalidPlanError,
  UnauthorizedFabricError,
  UnsupportedCommunicationError,
  RepositoryConsistencyError,
  ContentLeakError,
  FabricConfigurationError,
} from "../errors.js";
import {
  ALL_COMMUNICATION_TYPES,
  DEFERRED_COMMUNICATION_TYPES,
  ALL_CONVERSATION_TYPES,
  ALL_MEDIA_TYPES,
  ALL_PRIORITIES,
  ALL_STRATEGY_TYPES,
  ALL_ROUTE_KINDS,
  ALL_SUBSYSTEM_KINDS,
  ConversationType,
} from "../types/types.js";

const ID_RE = /^[A-Za-z0-9_.:#@\-/]{1,200}$/;

/** Field names that must NEVER appear in a fabric control-plane record (secret / content markers). */
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
  "message",
  "bytes",
  "buffer",
  "blob",
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_KEYS.map((k) => k.toLowerCase()));

/**
 * Deep-scan an object graph for forbidden content/secret keys. Throws on the first hit. Bounded depth so
 * a pathological structure cannot hang the scan.
 * @throws {ContentLeakError}
 */
export function assertNoContent(obj, { path = "", depth = 0 } = {}) {
  if (obj == null || typeof obj !== "object" || depth > 8) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoContent(v, { path: `${path}[${i}]`, depth: depth + 1 }));
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (FORBIDDEN_SET.has(key.toLowerCase())) {
      throw new ContentLeakError(`Forbidden content/secret field "${key}" in a control-plane record`, { details: { path: `${path}.${key}` } });
    }
    assertNoContent(val, { path: `${path}.${key}`, depth: depth + 1 });
  }
}

/** Validate an id reference. @throws {InvalidRequestError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new InvalidRequestError(`Invalid ${label}`, { details: { value: id } });
  return id;
}

/** Guard against the deferred (voice/video) communication types this sprint does not execute. */
export function assertSupportedType(type) {
  if (DEFERRED_COMMUNICATION_TYPES.includes(type)) {
    throw new UnsupportedCommunicationError(`Communication type "${type}" is not supported until a later layer`, { details: { type } });
  }
}

/**
 * Validate a normalized communication request (STEP 14 "Invalid Context" precondition).
 * @param {import("../dto/dto.js").NormalizedRequest} req
 */
export function validateRequest(req) {
  if (!req || typeof req !== "object") throw new InvalidRequestError("Request must be an object");
  if (!ALL_COMMUNICATION_TYPES.includes(req.type)) throw new InvalidRequestError(`Unknown communication type "${req.type}"`, { details: { type: req.type } });
  assertSupportedType(req.type);
  validateRef(req.senderId, "senderId");
  if (!ALL_CONVERSATION_TYPES.includes(req.conversationType)) throw new InvalidRequestError(`Unknown conversation type "${req.conversationType}"`);
  if (!ALL_MEDIA_TYPES.includes(req.mediaType)) throw new InvalidRequestError(`Unknown media type "${req.mediaType}"`);
  if (!ALL_PRIORITIES.includes(req.priority)) throw new InvalidRequestError(`Unknown priority "${req.priority}"`);

  // conversation-shape coherence
  if (req.conversationType === ConversationType.GROUP && !req.groupId) throw new InvalidRequestError("Group conversation requires a groupId");
  if (req.conversationType === ConversationType.DIRECT && req.recipients.length === 0 && !req.conversationId) {
    throw new InvalidRequestError("Direct conversation requires a recipient or conversationId");
  }
  for (const r of req.recipients) validateRef(r, "recipient");

  // the request must not smuggle content
  assertNoContent(req);
  return req;
}

/** Validate an assembled context. @throws {InvalidContextError} */
export function validateContext(context) {
  const raw = context?.raw ?? context;
  if (!raw || typeof raw !== "object") throw new InvalidContextError("Context must be an object");
  for (const facet of ["conversation", "media", "recipient", "synchronization", "security", "transport", "execution", "diagnostics"]) {
    if (!raw[facet] || typeof raw[facet] !== "object") throw new InvalidContextError(`Context is missing the "${facet}" facet`, { details: { facet } });
  }
  if (!ALL_CONVERSATION_TYPES.includes(raw.conversation.type)) throw new InvalidContextError(`Context has an invalid conversation type "${raw.conversation.type}"`);
  if (!ALL_MEDIA_TYPES.includes(raw.media.type)) throw new InvalidContextError(`Context has an invalid media type "${raw.media.type}"`);
  assertNoContent(raw);
  return context;
}

/** Validate a decision + confirm its strategy is registered. @throws {InvalidDecisionError} */
export function validateDecision(decision, strategyRegistry) {
  if (!decision || typeof decision !== "object") throw new InvalidDecisionError("Decision must be an object");
  if (!ALL_STRATEGY_TYPES.includes(decision.strategyType)) throw new InvalidDecisionError(`Decision names an unknown strategy "${decision.strategyType}"`);
  if (!ALL_ROUTE_KINDS.includes(decision.primaryRoute)) throw new InvalidDecisionError(`Decision names an unknown route "${decision.primaryRoute}"`);
  if (strategyRegistry && !strategyRegistry.has(decision.strategyType)) throw new InvalidDecisionError(`Decision strategy "${decision.strategyType}" is not registered`);
  for (const sub of decision.subsystems ?? []) if (!ALL_SUBSYSTEM_KINDS.includes(sub)) throw new InvalidDecisionError(`Decision references unknown subsystem "${sub}"`);
  assertNoContent(decision);
  return decision;
}

/** Validate execution-plan consistency (dependency graph, subsystems, at least one required step). */
export function validateExecutionPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) throw new InvalidPlanError("Plan must have at least one step");
  const ids = new Set();
  let required = 0;
  for (const step of plan.steps) {
    if (!step.stepId || ids.has(step.stepId)) throw new InvalidPlanError("Plan has a duplicate/missing stepId", { details: { stepId: step.stepId } });
    if (!ALL_SUBSYSTEM_KINDS.includes(step.subsystem)) throw new InvalidPlanError(`Plan step names unknown subsystem "${step.subsystem}"`);
    if (!ALL_ROUTE_KINDS.includes(step.route)) throw new InvalidPlanError(`Plan step names unknown route "${step.route}"`);
    for (const dep of step.dependsOn ?? []) if (!ids.has(dep)) throw new InvalidPlanError(`Plan step "${step.stepId}" has an unresolved dependency "${dep}"`);
    ids.add(step.stepId);
    if (step.required) required++;
  }
  if (required === 0) throw new InvalidPlanError("Plan has no required step");
  assertNoContent(plan);
  return plan;
}

/**
 * Authorize the operation: the caller must be the request's sender (no spoofing another identity's
 * outgoing communication). Pass `{ allowServer: true }` for trusted server-driven flows.
 * @throws {UnauthorizedFabricError}
 */
export function assertAuthorized(req, callerId, { allowServer = false } = {}) {
  if (allowServer && callerId == null) return req;
  if (callerId == null) throw new UnauthorizedFabricError("Missing caller identity");
  if (String(req.senderId) !== String(callerId)) {
    throw new UnauthorizedFabricError("Caller may only initiate communication as themselves", { details: { senderId: req.senderId } });
  }
  return req;
}

/** Validate a repository bundle exposes the required stores + methods. @throws {RepositoryConsistencyError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new RepositoryConsistencyError("Repository bundle is required");
  const contracts = {
    decisions: ["create", "findById", "listByRequest"],
    plans: ["create", "findById"],
    executions: ["create", "findById", "listRecent"],
    audit: ["append", "listByRequest"],
  };
  for (const [store, methods] of Object.entries(contracts)) {
    if (!repo[store] || typeof repo[store] !== "object") throw new RepositoryConsistencyError(`Repository is missing the "${store}" store`, { details: { store } });
    for (const m of methods) if (typeof repo[store][m] !== "function") throw new RepositoryConsistencyError(`Repository store "${store}" is missing method "${m}"`, { details: { store, method: m } });
  }
  return repo;
}

/** Validate the fabric configuration object (config bag + numeric bounds). @throws {FabricConfigurationError} */
export function validateConfig(config = {}) {
  if (typeof config !== "object") throw new FabricConfigurationError("Config must be an object");
  if (config.decisionCacheTtlMs != null && (typeof config.decisionCacheTtlMs !== "number" || config.decisionCacheTtlMs < 0)) {
    throw new FabricConfigurationError("decisionCacheTtlMs must be a non-negative number");
  }
  if (config.decisionCacheMax != null && (typeof config.decisionCacheMax !== "number" || config.decisionCacheMax < 1)) {
    throw new FabricConfigurationError("decisionCacheMax must be a positive number");
  }
  return config;
}
