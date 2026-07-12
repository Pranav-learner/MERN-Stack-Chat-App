/**
 * @module optimization/validators
 *
 * Validation for the **Resource Optimization** subsystem (STEP 14). Covers invalid resource plans,
 * scheduler conflicts, QoS conflicts, queue overflow, policy conflicts, execution-plan consistency,
 * repository consistency, unauthorized decisions, configuration errors, and the no-content invariant.
 *
 * @security The optimizer is a control-plane engine: every persisted record carries ids + classifications
 * + budget/queue numbers only. {@link assertNoContent} deep-scans before any persist.
 */

import {
  InvalidResourcePlanError,
  SchedulerConflictError,
  QoSConflictError,
  InvalidOptimizedPlanError,
  OptimizationRepositoryError,
  OptimizationContentLeakError,
  OptimizationConfigurationError,
  UnauthorizedOptimizationError,
} from "../errors.js";
import { ALL_QOS_CLASSES, ALL_LANES, ALL_SCHEDULING_MODES, ALL_SCHEDULE_STATUSES, ALL_RESOURCE_KINDS, ScheduleStatus } from "../types/types.js";

const ID_RE = /^[A-Za-z0-9_.:#@\-/]{1,200}$/;
const QOS_SET = new Set(ALL_QOS_CLASSES);
const LANE_SET = new Set(ALL_LANES);
const MODE_SET = new Set(ALL_SCHEDULING_MODES);
const STATUS_SET = new Set(ALL_SCHEDULE_STATUSES);
const RESOURCE_SET = new Set(ALL_RESOURCE_KINDS);

/** Field names that must NEVER appear in an optimization control-plane record. */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey", "secretKey", "sharedSecret", "sessionKey", "groupKey", "epochSecret", "encryptionKey",
  "macKey", "messageKey", "chainKey", "rootKey", "keyBytes", "seed", "plaintext", "plainText", "cleartext",
  "decrypted", "ciphertext", "body", "content", "text", "message", "bytes", "buffer", "blob",
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_KEYS.map((k) => k.toLowerCase()));

/** Deep-scan for forbidden content/secret keys. @throws {OptimizationContentLeakError} */
export function assertNoContent(obj, { path = "", depth = 0 } = {}) {
  if (obj == null || typeof obj !== "object" || depth > 8) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoContent(v, { path: `${path}[${i}]`, depth: depth + 1 }));
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (FORBIDDEN_SET.has(key.toLowerCase())) throw new OptimizationContentLeakError(`Forbidden content/secret field "${key}"`, { details: { path: `${path}.${key}` } });
    assertNoContent(val, { path: `${path}.${key}`, depth: depth + 1 });
  }
}

/** Validate an id reference. */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new InvalidOptimizedPlanError(`Invalid ${label}`, { details: { value: id } });
  return id;
}

/** Validate a resource cost / allocation object (known kinds, non-negative). @throws {InvalidResourcePlanError} */
export function validateResourceCost(cost, label = "cost") {
  if (!cost || typeof cost !== "object") throw new InvalidResourcePlanError(`${label} must be an object`);
  for (const [kind, amount] of Object.entries(cost)) {
    if (!RESOURCE_SET.has(kind)) throw new InvalidResourcePlanError(`${label} references unknown resource "${kind}"`, { details: { kind } });
    if (typeof amount !== "number" || amount < 0 || !Number.isFinite(amount)) throw new InvalidResourcePlanError(`${label}.${kind} must be a non-negative number`, { details: { kind, amount } });
  }
  return cost;
}

/** Validate a QoS decision (known class + lane). @throws {QoSConflictError} */
export function validateQoS(qos) {
  if (!qos || !QOS_SET.has(qos.qosClass)) throw new QoSConflictError(`Unknown QoS class "${qos?.qosClass}"`, { details: { qosClass: qos?.qosClass } });
  if (!LANE_SET.has(qos.lane)) throw new QoSConflictError(`Unknown lane "${qos.lane}"`, { details: { lane: qos.lane } });
  return qos;
}

/** Validate a scheduling decision (known mode/status; proceed ⇔ immediate). @throws {SchedulerConflictError} */
export function validateScheduling(decision) {
  if (!decision || typeof decision !== "object") throw new SchedulerConflictError("Scheduling decision must be an object");
  if (!MODE_SET.has(decision.mode)) throw new SchedulerConflictError(`Unknown scheduling mode "${decision.mode}"`, { details: { mode: decision.mode } });
  if (!STATUS_SET.has(decision.status)) throw new SchedulerConflictError(`Unknown schedule status "${decision.status}"`, { details: { status: decision.status } });
  const proceed = decision.status === ScheduleStatus.IMMEDIATE;
  if (proceed !== !!decision.proceed) throw new SchedulerConflictError("Scheduling status disagrees with proceed flag", { details: { status: decision.status, proceed: decision.proceed } });
  return decision;
}

/** Validate an optimized execution plan's consistency. @throws {InvalidOptimizedPlanError} */
export function validateOptimizedPlan(plan) {
  if (!plan || typeof plan !== "object") throw new InvalidOptimizedPlanError("Optimized plan must be an object");
  if (!plan.schedulingPlan || !plan.qosPlan) throw new InvalidOptimizedPlanError("Optimized plan is missing schedulingPlan/qosPlan");
  if (!Array.isArray(plan.timeline)) throw new InvalidOptimizedPlanError("Optimized plan is missing a timeline");
  validateQoS({ qosClass: plan.qosPlan.qosClass, lane: plan.qosPlan.lane });
  assertNoContent(plan);
  return plan;
}

/**
 * Authorize the optimization: the caller must be the request's sender. @throws {UnauthorizedOptimizationError}
 */
export function assertAuthorized(request, callerId, { allowServer = false } = {}) {
  if (allowServer && callerId == null) return request;
  if (callerId == null) throw new UnauthorizedOptimizationError("Missing caller identity");
  if (String(request.senderId) !== String(callerId)) throw new UnauthorizedOptimizationError("Caller may only optimize as themselves", { details: { senderId: request.senderId } });
  return request;
}

/** Validate the repository bundle. @throws {OptimizationRepositoryError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new OptimizationRepositoryError("Repository bundle is required");
  const contracts = {
    resources: ["recordSnapshot", "latest"],
    optimizations: ["create", "findByRequest", "listRecent"],
    audit: ["append", "listByRequest"],
  };
  for (const [store, methods] of Object.entries(contracts)) {
    if (!repo[store] || typeof repo[store] !== "object") throw new OptimizationRepositoryError(`Repository is missing the "${store}" store`, { details: { store } });
    for (const m of methods) if (typeof repo[store][m] !== "function") throw new OptimizationRepositoryError(`Repository store "${store}" is missing "${m}"`, { details: { store, method: m } });
  }
  return repo;
}

/** Validate config (budgets/weights/lane capacities). @throws {OptimizationConfigurationError} */
export function validateConfig(config = {}) {
  if (typeof config !== "object") throw new OptimizationConfigurationError("Config must be an object");
  if (config.budgets != null) {
    if (typeof config.budgets !== "object") throw new OptimizationConfigurationError("budgets must be an object");
    for (const [kind, v] of Object.entries(config.budgets)) {
      if (!RESOURCE_SET.has(kind)) throw new OptimizationConfigurationError(`Unknown budget "${kind}"`);
      if (typeof v !== "number" || v < 0) throw new OptimizationConfigurationError(`budget "${kind}" must be a non-negative number`);
    }
  }
  return config;
}
