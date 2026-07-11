/**
 * @module presence/errors
 *
 * Typed error hierarchy for the Presence Service (Layer 6, Sprint 2). Each error carries a
 * stable `.code` and HTTP `.status`, in its own `ERR_PRESENCE_*` namespace — distinct from
 * discovery (`ERR_DISCOVERY_*`), identity (`ERR_IDENTITY_*`), and the crypto subsystems.
 */

/** Base class for all Presence errors. */
export class PresenceError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_PRESENCE";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A presence input (ids, status, request shape, advertisement) failed validation. */
export class PresenceValidationError extends PresenceError {
  constructor(message = "Presence validation failed", options = {}) {
    super(message, { code: "ERR_PRESENCE_VALIDATION", status: 400, ...options });
  }
}

/** No presence record exists for the requested id/device. */
export class PresenceNotFoundError extends PresenceError {
  constructor(message = "Presence record not found", options = {}) {
    super(message, { code: "ERR_PRESENCE_NOT_FOUND", status: 404, ...options });
  }
}

/** A presence registration collides with an existing active one for the same device. */
export class DuplicatePresenceError extends PresenceError {
  constructor(message = "Presence already registered for this device", options = {}) {
    super(message, { code: "ERR_PRESENCE_DUPLICATE", status: 409, ...options });
  }
}

/** An illegal presence-status transition was attempted. */
export class InvalidPresenceTransitionError extends PresenceError {
  constructor(message = "Invalid presence status transition", options = {}) {
    super(message, { code: "ERR_PRESENCE_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** A presence record outlived its heartbeat timeout. */
export class PresenceExpiredError extends PresenceError {
  constructor(message = "Presence has expired (heartbeat timeout)", options = {}) {
    super(message, { code: "ERR_PRESENCE_EXPIRED", status: 410, ...options });
  }
}

/** The caller is not permitted to update / inspect this presence record. */
export class UnauthorizedPresenceError extends PresenceError {
  constructor(message = "Unauthorized presence request", options = {}) {
    super(message, { code: "ERR_PRESENCE_UNAUTHORIZED", status: 403, ...options });
  }
}

/** A presence record or advertisement is malformed, tampered, or carries secret material. */
export class CorruptedPresenceError extends PresenceError {
  constructor(message = "Presence record is corrupted", options = {}) {
    super(message, { code: "ERR_PRESENCE_CORRUPTED", status: 422, ...options });
  }
}
