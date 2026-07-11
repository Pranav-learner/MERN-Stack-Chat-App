/**
 * @module pdp/errors
 *
 * Typed error hierarchy for the Peer Discovery Protocol (Layer 6, Sprint 4). Each error carries a
 * stable `.code` and HTTP `.status`, in its own `ERR_PDP_*` namespace — distinct from discovery
 * (`ERR_DISCOVERY_*`), presence (`ERR_PRESENCE_*`), and capabilities (`ERR_CAPABILITY_*`).
 */

/** Base class for all Peer Discovery Protocol errors. */
export class PdpError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_PDP";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A PDP input (ids, request shape, policy) failed validation. */
export class PdpValidationError extends PdpError {
  constructor(message = "PDP validation failed", options = {}) {
    super(message, { code: "ERR_PDP_VALIDATION", status: 400, ...options });
  }
}

/** No PDP session / connection plan exists for the requested id. */
export class PdpNotFoundError extends PdpError {
  constructor(message = "Discovery session not found", options = {}) {
    super(message, { code: "ERR_PDP_NOT_FOUND", status: 404, ...options });
  }
}

/** An illegal PDP-state transition was attempted. */
export class InvalidPdpTransitionError extends PdpError {
  constructor(message = "Invalid PDP state transition", options = {}) {
    super(message, { code: "ERR_PDP_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** A stage of the discovery workflow failed. Carries the stage + machine-readable reason. */
export class WorkflowStageError extends PdpError {
  /** @param {string} message @param {{stage?:string, reason?:string, status?:number, cause?:unknown, details?:object}} [options] */
  constructor(message = "Discovery workflow stage failed", options = {}) {
    super(message, { code: "ERR_PDP_WORKFLOW_STAGE", status: options.status ?? 409, ...options });
    if (options.stage !== undefined) this.stage = options.stage;
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

/** A connection plan outlived its TTL. */
export class PlanExpiredError extends PdpError {
  constructor(message = "Connection plan has expired", options = {}) {
    super(message, { code: "ERR_PDP_PLAN_EXPIRED", status: 410, ...options });
  }
}

/** A PDP session outlived its TTL. */
export class PdpExpiredError extends PdpError {
  constructor(message = "Discovery session has expired", options = {}) {
    super(message, { code: "ERR_PDP_EXPIRED", status: 410, ...options });
  }
}

/** The caller is not permitted to perform / inspect this discovery. */
export class UnauthorizedPdpError extends PdpError {
  constructor(message = "Unauthorized discovery request", options = {}) {
    super(message, { code: "ERR_PDP_UNAUTHORIZED", status: 403, ...options });
  }
}

/** A PDP record or connection plan is malformed, tampered, or carries forbidden secret material. */
export class CorruptedPlanError extends PdpError {
  constructor(message = "Connection plan is corrupted", options = {}) {
    super(message, { code: "ERR_PDP_CORRUPTED", status: 422, ...options });
  }
}
