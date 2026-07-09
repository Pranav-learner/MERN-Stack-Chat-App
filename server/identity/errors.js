/**
 * @module identity/errors
 *
 * Typed error hierarchy for the Identity subsystem. Every error carries a stable
 * machine-readable `.code` and an HTTP `.status` so the controller layer can map
 * failures to responses without string-matching.
 */

/**
 * Base class for all Identity subsystem errors.
 */
export class IdentityError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, cause?: unknown, details?: object }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_IDENTITY";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A submitted identity/device/public-key/fingerprint failed validation. */
export class IdentityValidationError extends IdentityError {
  constructor(message = "Identity validation failed", options = {}) {
    super(message, { code: "ERR_IDENTITY_VALIDATION", status: 400, ...options });
  }
}

/** The user already owns a (different) identity. */
export class DuplicateIdentityError extends IdentityError {
  constructor(message = "Identity already exists", options = {}) {
    super(message, { code: "ERR_DUPLICATE_IDENTITY", status: 409, ...options });
  }
}

/** No identity exists for the requested user. */
export class IdentityNotFoundError extends IdentityError {
  constructor(message = "Identity not found", options = {}) {
    super(message, { code: "ERR_IDENTITY_NOT_FOUND", status: 404, ...options });
  }
}

/** No device exists for the requested id. */
export class DeviceNotFoundError extends IdentityError {
  constructor(message = "Device not found", options = {}) {
    super(message, { code: "ERR_DEVICE_NOT_FOUND", status: 404, ...options });
  }
}

/** A device with the same id already exists. */
export class DuplicateDeviceError extends IdentityError {
  constructor(message = "Device already exists", options = {}) {
    super(message, { code: "ERR_DUPLICATE_DEVICE", status: 409, ...options });
  }
}

/** The caller does not own the identity/device they are acting on. */
export class IdentityOwnershipError extends IdentityError {
  constructor(message = "Not authorized for this identity resource", options = {}) {
    super(message, { code: "ERR_IDENTITY_OWNERSHIP", status: 403, ...options });
  }
}
