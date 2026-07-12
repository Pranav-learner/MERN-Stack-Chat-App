/**
 * @module optimization/errors
 *
 * Typed error hierarchy for the **Resource Optimization** subsystem (Layer 12, Sprint 3). Every error
 * carries a stable `.code`, an HTTP `.status`, and a machine-readable `.reason` from
 * {@link OptimizationFailureReason}. Mirrors the frozen lower layers so the HTTP controller translates any
 * optimization error uniformly.
 *
 * @security Errors carry ids + classifications + the offending (validated-safe) metadata only — never
 * content/keys.
 */

import { OptimizationFailureReason } from "./types/types.js";

export class OptimizationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_OPT";
    this.status = options.status ?? 400;
    this.reason = options.reason ?? OptimizationFailureReason.INTERNAL_ERROR;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A resource allocation plan is malformed / references an unknown budget. */
export class InvalidResourcePlanError extends OptimizationError {
  constructor(message = "Invalid resource plan", options = {}) {
    super(message, { code: "ERR_OPT_INVALID_RESOURCE_PLAN", status: 422, reason: OptimizationFailureReason.INVALID_RESOURCE_PLAN, ...options });
  }
}

/** Two scheduling decisions contradict (e.g. immediate + deferred for the same item). */
export class SchedulerConflictError extends OptimizationError {
  constructor(message = "Scheduler conflict", options = {}) {
    super(message, { code: "ERR_OPT_SCHEDULER_CONFLICT", status: 409, reason: OptimizationFailureReason.SCHEDULER_CONFLICT, ...options });
  }
}

/** QoS classification is inconsistent (unknown class / conflicting lane). */
export class QoSConflictError extends OptimizationError {
  constructor(message = "QoS conflict", options = {}) {
    super(message, { code: "ERR_OPT_QOS_CONFLICT", status: 409, reason: OptimizationFailureReason.QOS_CONFLICT, ...options });
  }
}

/** A lane exceeded its capacity. */
export class QueueOverflowError extends OptimizationError {
  constructor(message = "Queue overflow", options = {}) {
    super(message, { code: "ERR_OPT_QUEUE_OVERFLOW", status: 429, reason: OptimizationFailureReason.QUEUE_OVERFLOW, ...options });
  }
}

/** Resource / scheduling policies produced contradictory constraints. */
export class OptimizationPolicyConflictError extends OptimizationError {
  constructor(message = "Conflicting optimization policies", options = {}) {
    super(message, { code: "ERR_OPT_POLICY_CONFLICT", status: 409, reason: OptimizationFailureReason.POLICY_CONFLICT, ...options });
  }
}

/** An optimized execution plan is inconsistent. */
export class InvalidOptimizedPlanError extends OptimizationError {
  constructor(message = "Invalid optimized execution plan", options = {}) {
    super(message, { code: "ERR_OPT_INVALID_PLAN", status: 422, reason: OptimizationFailureReason.INVALID_PLAN, ...options });
  }
}

/** A repository violated its contract. */
export class OptimizationRepositoryError extends OptimizationError {
  constructor(message = "Optimization repository inconsistency", options = {}) {
    super(message, { code: "ERR_OPT_REPO", status: 500, reason: OptimizationFailureReason.REPOSITORY_INCONSISTENT, ...options });
  }
}

/** The optimizer or a component was configured incorrectly. */
export class OptimizationConfigurationError extends OptimizationError {
  constructor(message = "Optimization configuration error", options = {}) {
    super(message, { code: "ERR_OPT_CONFIG", status: 500, reason: OptimizationFailureReason.CONFIGURATION_ERROR, ...options });
  }
}

/** The caller is not authorized. */
export class UnauthorizedOptimizationError extends OptimizationError {
  constructor(message = "Unauthorized optimization", options = {}) {
    super(message, { code: "ERR_OPT_UNAUTHORIZED", status: 403, reason: OptimizationFailureReason.UNAUTHORIZED, ...options });
  }
}

/** Content / key material detected in a control-plane record. */
export class OptimizationContentLeakError extends OptimizationError {
  constructor(message = "Content/key material detected in an optimization record", options = {}) {
    super(message, { code: "ERR_OPT_CONTENT_LEAK", status: 500, reason: OptimizationFailureReason.CONTENT_LEAK, ...options });
  }
}

/** Generic validation failure. */
export class OptimizationValidationError extends OptimizationError {
  constructor(message = "Optimization validation failed", options = {}) {
    super(message, { code: "ERR_OPT_VALIDATION", status: 400, reason: OptimizationFailureReason.INVALID_PLAN, ...options });
  }
}
