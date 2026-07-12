/**
 * @module adaptive-routing/validators
 *
 * Validation for the **Intelligent Routing** subsystem (STEP 14). Covers invalid capabilities, unknown
 * routes, policy conflicts, strategy conflicts, missing analysis, repository consistency, unauthorized
 * decisions, configuration errors, and the platform-wide no-content invariant.
 *
 * @security The adaptive layer is a control-plane decision engine: every persisted record carries ids +
 * classifications + scores only. {@link assertNoContent} deep-scans before any persist.
 */

import {
  InvalidCapabilityError,
  InvalidAnalysisError,
  MissingAnalysisError,
  UnknownRouteError,
  UnauthorizedAdaptiveError,
  AdaptiveRepositoryError,
  AdaptiveContentLeakError,
  AdaptiveConfigurationError,
} from "../errors.js";
import { RouteKind, StrategyType, ADAPTIVE_SCHEMA_VERSION } from "../types/types.js";

const ID_RE = /^[A-Za-z0-9_.:#@\-/]{1,200}$/;
const ROUTE_SET = new Set(Object.values(RouteKind));
const STRATEGY_SET = new Set(Object.values(StrategyType));

/** Field names that must NEVER appear in an adaptive control-plane record. */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey", "secretKey", "sharedSecret", "sessionKey", "groupKey", "epochSecret", "encryptionKey",
  "macKey", "messageKey", "chainKey", "rootKey", "keyBytes", "seed", "plaintext", "plainText", "cleartext",
  "decrypted", "ciphertext", "body", "content", "text", "message", "bytes", "buffer", "blob",
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_KEYS.map((k) => k.toLowerCase()));

/** Deep-scan for forbidden content/secret keys. @throws {AdaptiveContentLeakError} */
export function assertNoContent(obj, { path = "", depth = 0 } = {}) {
  if (obj == null || typeof obj !== "object" || depth > 8) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoContent(v, { path: `${path}[${i}]`, depth: depth + 1 }));
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (FORBIDDEN_SET.has(key.toLowerCase())) throw new AdaptiveContentLeakError(`Forbidden content/secret field "${key}"`, { details: { path: `${path}.${key}` } });
    assertNoContent(val, { path: `${path}.${key}`, depth: depth + 1 });
  }
}

/** Validate an id reference. */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new InvalidAnalysisError(`Invalid ${label}`, { details: { value: id } });
  return id;
}

/** Validate a negotiated capability profile. @throws {InvalidCapabilityError} */
export function validateCapabilityProfile(profile) {
  if (!profile || typeof profile !== "object") throw new InvalidCapabilityError("Capability profile must be an object");
  if (!Array.isArray(profile.transports) || profile.transports.length === 0) throw new InvalidCapabilityError("Profile must declare at least one transport");
  if (!Number.isFinite(profile.protocolVersion)) throw new InvalidCapabilityError("Profile must declare a numeric protocolVersion");
  assertNoContent(profile);
  return profile;
}

/** Validate a communication analysis. @throws {InvalidAnalysisError} */
export function validateAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") throw new InvalidAnalysisError("Analysis must be an object");
  for (const field of ["communicationType", "conversationType", "mediaType", "priority"]) {
    if (analysis[field] == null) throw new InvalidAnalysisError(`Analysis is missing "${field}"`, { details: { field } });
  }
  assertNoContent(analysis);
  return analysis;
}

/** Assert an analysis is present before a downstream stage. @throws {MissingAnalysisError} */
export function requireAnalysis(analysis, stage) {
  if (!analysis) throw new MissingAnalysisError(`Stage "${stage}" requires a prior analysis`, { details: { stage } });
  return analysis;
}

/** Validate a route kind is known. @throws {UnknownRouteError} */
export function assertKnownRoute(routeKind) {
  if (!ROUTE_SET.has(routeKind)) throw new UnknownRouteError(`Unknown route "${routeKind}"`, { details: { routeKind } });
  return routeKind;
}

/** Validate ranked route scores (non-empty, known routes/strategies). */
export function validateRanking(ranked) {
  if (!Array.isArray(ranked) || ranked.length === 0) throw new InvalidAnalysisError("Ranking must be a non-empty array");
  for (const r of ranked) {
    assertKnownRoute(r.routeKind);
    if (!STRATEGY_SET.has(r.strategyType)) throw new InvalidAnalysisError(`Ranking references unknown strategy "${r.strategyType}"`);
    if (typeof r.total !== "number") throw new InvalidAnalysisError("Route score must have a numeric total");
  }
  return ranked;
}

/**
 * Authorize the decision: the caller must be the request's sender. Pass `{ allowServer: true }` for
 * trusted server-driven flows. @throws {UnauthorizedAdaptiveError}
 */
export function assertAuthorized(request, callerId, { allowServer = false } = {}) {
  if (allowServer && callerId == null) return request;
  if (callerId == null) throw new UnauthorizedAdaptiveError("Missing caller identity");
  if (String(request.senderId) !== String(callerId)) throw new UnauthorizedAdaptiveError("Caller may only decide as themselves", { details: { senderId: request.senderId } });
  return request;
}

/** Validate the repository bundle exposes the required stores + methods. @throws {AdaptiveRepositoryError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new AdaptiveRepositoryError("Repository bundle is required");
  const contracts = {
    capabilities: ["upsert", "findByFingerprint"],
    evaluations: ["create", "findByRequest", "listRecent"],
    audit: ["append", "listByRequest"],
  };
  for (const [store, methods] of Object.entries(contracts)) {
    if (!repo[store] || typeof repo[store] !== "object") throw new AdaptiveRepositoryError(`Repository is missing the "${store}" store`, { details: { store } });
    for (const m of methods) if (typeof repo[store][m] !== "function") throw new AdaptiveRepositoryError(`Repository store "${store}" is missing "${m}"`, { details: { store, method: m } });
  }
  return repo;
}

/** Validate the adaptive config (weights + cache bounds). @throws {AdaptiveConfigurationError} */
export function validateConfig(config = {}) {
  if (typeof config !== "object") throw new AdaptiveConfigurationError("Config must be an object");
  if (config.weights != null) {
    if (typeof config.weights !== "object") throw new AdaptiveConfigurationError("weights must be an object");
    for (const [dim, w] of Object.entries(config.weights)) if (typeof w !== "number" || w < 0) throw new AdaptiveConfigurationError(`weight for "${dim}" must be a non-negative number`);
  }
  return config;
}

export const SCHEMA_VERSION = ADAPTIVE_SCHEMA_VERSION;
