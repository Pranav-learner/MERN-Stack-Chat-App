/**
 * @module endpoint-selection/errors
 *
 * Typed error hierarchy for the Endpoint Selection subsystem (Layer 6, Sprint 5). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_ENDPOINT_*` namespace — distinct
 * from discovery / presence / capabilities / PDP errors.
 */

/** Base class for all Endpoint Selection errors. */
export class EndpointError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_ENDPOINT";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** An endpoint input (ids, candidates, policy, weights) failed validation. */
export class EndpointValidationError extends EndpointError {
  constructor(message = "Endpoint validation failed", options = {}) {
    super(message, { code: "ERR_ENDPOINT_VALIDATION", status: 400, ...options });
  }
}

/** No connection plan / selection record exists for the requested id. */
export class EndpointNotFoundError extends EndpointError {
  constructor(message = "Connection plan not found", options = {}) {
    super(message, { code: "ERR_ENDPOINT_NOT_FOUND", status: 404, ...options });
  }
}

/** No usable endpoint could be selected from the candidates. Carries a machine-readable reason. */
export class SelectionFailedError extends EndpointError {
  /** @param {string} message @param {{reason?:string, status?:number, cause?:unknown, details?:object}} [options] */
  constructor(message = "Endpoint selection failed", options = {}) {
    super(message, { code: "ERR_ENDPOINT_SELECTION_FAILED", status: options.status ?? 409, ...options });
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

/** A failover was requested but no fallback endpoint is available. */
export class NoFallbackError extends EndpointError {
  constructor(message = "No fallback endpoint available", options = {}) {
    super(message, { code: "ERR_ENDPOINT_NO_FALLBACK", status: 409, ...options });
  }
}

/** A connection plan outlived its TTL. */
export class PlanExpiredError extends EndpointError {
  constructor(message = "Connection plan has expired", options = {}) {
    super(message, { code: "ERR_ENDPOINT_PLAN_EXPIRED", status: 410, ...options });
  }
}

/** The caller is not permitted to inspect / mutate this plan. */
export class UnauthorizedEndpointError extends EndpointError {
  constructor(message = "Unauthorized endpoint request", options = {}) {
    super(message, { code: "ERR_ENDPOINT_UNAUTHORIZED", status: 403, ...options });
  }
}

/** A plan/selection is malformed, tampered, or carries forbidden secret material. */
export class CorruptedPlanError extends EndpointError {
  constructor(message = "Connection plan is corrupted", options = {}) {
    super(message, { code: "ERR_ENDPOINT_CORRUPTED", status: 422, ...options });
  }
}
