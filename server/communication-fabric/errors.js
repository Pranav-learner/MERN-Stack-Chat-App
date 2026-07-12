/**
 * @module communication-fabric/errors
 *
 * Typed error hierarchy for the **Distributed Communication Fabric** (Layer 12, Sprint 1). Every error
 * carries a stable `.code`, an HTTP `.status`, and a machine-readable `.reason` from
 * {@link FabricFailureReason}. Mirrors the error style of the frozen lower layers (group-receipts /
 * media-reliability) so the HTTP controller can translate any fabric error uniformly.
 *
 * @security Fabric errors never embed message content or key material — only ids, classifications, and
 * the offending metadata (validated safe before being attached to `.details`).
 */

import { FabricFailureReason } from "./types/types.js";

export class FabricError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_FABRIC";
    this.status = options.status ?? 400;
    this.reason = options.reason ?? FabricFailureReason.INTERNAL_ERROR;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A malformed / incomplete communication request reached the Fabric. */
export class InvalidRequestError extends FabricError {
  constructor(message = "Invalid communication request", options = {}) {
    super(message, { code: "ERR_FABRIC_INVALID_REQUEST", status: 400, reason: FabricFailureReason.INVALID_REQUEST, ...options });
  }
}

/** The built communication context is inconsistent (missing sub-context, bad enum, etc.). */
export class InvalidContextError extends FabricError {
  constructor(message = "Invalid communication context", options = {}) {
    super(message, { code: "ERR_FABRIC_INVALID_CONTEXT", status: 422, reason: FabricFailureReason.INVALID_CONTEXT, ...options });
  }
}

/** A referenced strategy is not registered in the strategy registry. */
export class UnknownStrategyError extends FabricError {
  constructor(message = "Unknown communication strategy", options = {}) {
    super(message, { code: "ERR_FABRIC_UNKNOWN_STRATEGY", status: 422, reason: FabricFailureReason.UNKNOWN_STRATEGY, ...options });
  }
}

/** The Decision Engine could not match any strategy to the context. */
export class NoStrategyMatchedError extends FabricError {
  constructor(message = "No strategy matched the communication context", options = {}) {
    super(message, { code: "ERR_FABRIC_NO_STRATEGY", status: 422, reason: FabricFailureReason.NO_STRATEGY_MATCHED, ...options });
  }
}

/** A required policy set could not be resolved. */
export class MissingPolicyError extends FabricError {
  constructor(message = "Required communication policy is missing", options = {}) {
    super(message, { code: "ERR_FABRIC_MISSING_POLICY", status: 422, reason: FabricFailureReason.MISSING_POLICY, ...options });
  }
}

/** A policy actively denied the request. */
export class PolicyDeniedError extends FabricError {
  constructor(message = "Communication denied by policy", options = {}) {
    super(message, { code: "ERR_FABRIC_POLICY_DENIED", status: 403, reason: FabricFailureReason.POLICY_DENIED, ...options });
  }
}

/** A produced decision failed its invariant checks. */
export class InvalidDecisionError extends FabricError {
  constructor(message = "Invalid communication decision", options = {}) {
    super(message, { code: "ERR_FABRIC_INVALID_DECISION", status: 422, reason: FabricFailureReason.INVALID_DECISION, ...options });
  }
}

/** A built execution plan is inconsistent (bad dependency graph, unknown subsystem, empty required set). */
export class InvalidPlanError extends FabricError {
  constructor(message = "Invalid execution plan", options = {}) {
    super(message, { code: "ERR_FABRIC_INVALID_PLAN", status: 422, reason: FabricFailureReason.INVALID_PLAN, ...options });
  }
}

/** No adapter is registered for a subsystem a plan step needs. */
export class SubsystemUnavailableError extends FabricError {
  constructor(message = "Required subsystem is not registered", options = {}) {
    super(message, { code: "ERR_FABRIC_SUBSYSTEM_UNAVAILABLE", status: 503, reason: FabricFailureReason.SUBSYSTEM_UNAVAILABLE, ...options });
  }
}

/** A registered subsystem adapter threw while executing a step. */
export class SubsystemFailedError extends FabricError {
  constructor(message = "Subsystem failed while executing a step", options = {}) {
    super(message, { code: "ERR_FABRIC_SUBSYSTEM_FAILED", status: 502, reason: FabricFailureReason.SUBSYSTEM_FAILED, ...options });
  }
}

/** The caller is not authorized for the requested operation (e.g. spoofing another sender). */
export class UnauthorizedFabricError extends FabricError {
  constructor(message = "Unauthorized communication operation", options = {}) {
    super(message, { code: "ERR_FABRIC_UNAUTHORIZED", status: 403, reason: FabricFailureReason.UNAUTHORIZED, ...options });
  }
}

/** A communication type that is declared but NOT executable in this sprint (voice/video). */
export class UnsupportedCommunicationError extends FabricError {
  constructor(message = "Communication type is not supported in this sprint", options = {}) {
    super(message, { code: "ERR_FABRIC_UNSUPPORTED", status: 501, reason: FabricFailureReason.UNSUPPORTED_TYPE, ...options });
  }
}

/** The Fabric or one of its components was configured incorrectly. */
export class FabricConfigurationError extends FabricError {
  constructor(message = "Communication Fabric configuration error", options = {}) {
    super(message, { code: "ERR_FABRIC_CONFIG", status: 500, reason: FabricFailureReason.CONFIGURATION_ERROR, ...options });
  }
}

/** A repository violated its contract (missing store method, dangling reference). */
export class RepositoryConsistencyError extends FabricError {
  constructor(message = "Fabric repository inconsistency", options = {}) {
    super(message, { code: "ERR_FABRIC_REPO", status: 500, reason: FabricFailureReason.REPOSITORY_INCONSISTENT, ...options });
  }
}

/** Content / key material was detected in a control-plane record (invariant breach). */
export class ContentLeakError extends FabricError {
  constructor(message = "Content/key material detected in a control-plane record", options = {}) {
    super(message, { code: "ERR_FABRIC_CONTENT_LEAK", status: 500, reason: FabricFailureReason.CONTENT_LEAK, ...options });
  }
}

/** Generic validation failure. */
export class FabricValidationError extends FabricError {
  constructor(message = "Fabric validation failed", options = {}) {
    super(message, { code: "ERR_FABRIC_VALIDATION", status: 400, reason: FabricFailureReason.INVALID_REQUEST, ...options });
  }
}
