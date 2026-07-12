/**
 * @module adaptive-routing/errors
 *
 * Typed error hierarchy for the **Intelligent Routing** subsystem (Layer 12, Sprint 2). Every error
 * carries a stable `.code`, an HTTP `.status`, and a machine-readable `.reason` from
 * {@link AdaptiveFailureReason}. Mirrors the frozen lower layers so the HTTP controller translates any
 * adaptive error uniformly.
 *
 * @security Adaptive errors carry ids + classifications + the offending (validated-safe) metadata only —
 * never content/keys.
 */

import { AdaptiveFailureReason } from "./types/types.js";

export class AdaptiveRoutingError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_ADAPTIVE";
    this.status = options.status ?? 400;
    this.reason = options.reason ?? AdaptiveFailureReason.INTERNAL_ERROR;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A capability profile was malformed / failed negotiation. */
export class InvalidCapabilityError extends AdaptiveRoutingError {
  constructor(message = "Invalid capability profile", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_INVALID_CAPABILITY", status: 422, reason: AdaptiveFailureReason.INVALID_CAPABILITIES, ...options });
  }
}

/** The communication analysis is missing or inconsistent. */
export class InvalidAnalysisError extends AdaptiveRoutingError {
  constructor(message = "Invalid communication analysis", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_INVALID_ANALYSIS", status: 422, reason: AdaptiveFailureReason.INVALID_ANALYSIS, ...options });
  }
}

/** A required analysis stage did not run before a later stage. */
export class MissingAnalysisError extends AdaptiveRoutingError {
  constructor(message = "Required analysis is missing", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_MISSING_ANALYSIS", status: 500, reason: AdaptiveFailureReason.MISSING_ANALYSIS, ...options });
  }
}

/** No candidate route scored above the viability floor. */
export class NoViableRouteError extends AdaptiveRoutingError {
  constructor(message = "No viable route for this communication", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_NO_VIABLE_ROUTE", status: 422, reason: AdaptiveFailureReason.NO_VIABLE_ROUTE, ...options });
  }
}

/** A referenced route kind is unknown. */
export class UnknownRouteError extends AdaptiveRoutingError {
  constructor(message = "Unknown route", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_UNKNOWN_ROUTE", status: 422, reason: AdaptiveFailureReason.UNKNOWN_ROUTE, ...options });
  }
}

/** Two policies produced contradictory constraints. */
export class PolicyConflictError extends AdaptiveRoutingError {
  constructor(message = "Conflicting communication policies", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_POLICY_CONFLICT", status: 409, reason: AdaptiveFailureReason.POLICY_CONFLICT, ...options });
  }
}

/** The selected strategy conflicts with the analysis / capabilities. */
export class StrategyConflictError extends AdaptiveRoutingError {
  constructor(message = "Strategy conflict", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_STRATEGY_CONFLICT", status: 409, reason: AdaptiveFailureReason.STRATEGY_CONFLICT, ...options });
  }
}

/** The caller is not authorized to make this decision. */
export class UnauthorizedAdaptiveError extends AdaptiveRoutingError {
  constructor(message = "Unauthorized adaptive decision", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_UNAUTHORIZED", status: 403, reason: AdaptiveFailureReason.UNAUTHORIZED, ...options });
  }
}

/** A repository violated its contract. */
export class AdaptiveRepositoryError extends AdaptiveRoutingError {
  constructor(message = "Adaptive repository inconsistency", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_REPO", status: 500, reason: AdaptiveFailureReason.REPOSITORY_INCONSISTENT, ...options });
  }
}

/** The adaptive layer or a component was configured incorrectly. */
export class AdaptiveConfigurationError extends AdaptiveRoutingError {
  constructor(message = "Adaptive routing configuration error", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_CONFIG", status: 500, reason: AdaptiveFailureReason.CONFIGURATION_ERROR, ...options });
  }
}

/** Content / key material detected in a control-plane record. */
export class AdaptiveContentLeakError extends AdaptiveRoutingError {
  constructor(message = "Content/key material detected in an adaptive record", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_CONTENT_LEAK", status: 500, reason: AdaptiveFailureReason.CONTENT_LEAK, ...options });
  }
}

/** Generic validation failure. */
export class AdaptiveValidationError extends AdaptiveRoutingError {
  constructor(message = "Adaptive validation failed", options = {}) {
    super(message, { code: "ERR_ADAPTIVE_VALIDATION", status: 400, reason: AdaptiveFailureReason.INVALID_ANALYSIS, ...options });
  }
}
