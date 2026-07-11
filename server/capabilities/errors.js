/**
 * @module capabilities/errors
 *
 * Typed error hierarchy for the Capability Exchange subsystem (Layer 6, Sprint 3). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_CAPABILITY_*` namespace — distinct
 * from discovery (`ERR_DISCOVERY_*`), presence (`ERR_PRESENCE_*`), and the crypto subsystems.
 */

/** Base class for all Capability errors. */
export class CapabilityError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_CAPABILITY";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A capability input (ids, versions, flags, request shape) failed validation. */
export class CapabilityValidationError extends CapabilityError {
  constructor(message = "Capability validation failed", options = {}) {
    super(message, { code: "ERR_CAPABILITY_VALIDATION", status: 400, ...options });
  }
}

/** No capability set exists for the requested id/device. */
export class CapabilityNotFoundError extends CapabilityError {
  constructor(message = "Capability set not found", options = {}) {
    super(message, { code: "ERR_CAPABILITY_NOT_FOUND", status: 404, ...options });
  }
}

/** A capability registration collides with an existing live one for the same device. */
export class DuplicateCapabilityError extends CapabilityError {
  constructor(message = "Capabilities already registered for this device", options = {}) {
    super(message, { code: "ERR_CAPABILITY_DUPLICATE", status: 409, ...options });
  }
}

/** An illegal capability-state transition was attempted. */
export class InvalidCapabilityTransitionError extends CapabilityError {
  constructor(message = "Invalid capability state transition", options = {}) {
    super(message, { code: "ERR_CAPABILITY_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** A capability set outlived its TTL. */
export class CapabilityExpiredError extends CapabilityError {
  constructor(message = "Capability set has expired", options = {}) {
    super(message, { code: "ERR_CAPABILITY_EXPIRED", status: 410, ...options });
  }
}

/** The caller is not permitted to update / inspect this capability set. */
export class UnauthorizedCapabilityError extends CapabilityError {
  constructor(message = "Unauthorized capability request", options = {}) {
    super(message, { code: "ERR_CAPABILITY_UNAUTHORIZED", status: 403, ...options });
  }
}

/** Two devices could not agree on a way to communicate. */
export class NegotiationFailedError extends CapabilityError {
  constructor(message = "Capability negotiation failed", options = {}) {
    super(message, { code: "ERR_CAPABILITY_NEGOTIATION_FAILED", status: 409, ...options });
  }
}

/** A capability set is malformed, tampered, or carries forbidden secret material. */
export class CorruptedCapabilityError extends CapabilityError {
  constructor(message = "Capability set is corrupted", options = {}) {
    super(message, { code: "ERR_CAPABILITY_CORRUPTED", status: 422, ...options });
  }
}
