/**
 * @module device-trust/errors
 *
 * Typed error hierarchy for the Device Trust subsystem. Each carries a stable
 * `.code` and HTTP `.status` for the controller layer. Distinct from the Sprint 1
 * identity errors (separate namespace), though both expose `.status`.
 */

/** Base class for all Device Trust errors. */
export class DeviceTrustError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, cause?: unknown, details?: object }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_DEVICE_TRUST";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A device submission failed validation. */
export class DeviceValidationError extends DeviceTrustError {
  constructor(message = "Device validation failed", options = {}) {
    super(message, { code: "ERR_DEVICE_VALIDATION", status: 400, ...options });
  }
}

/** The requested device does not exist. */
export class DeviceNotFoundError extends DeviceTrustError {
  constructor(message = "Device not found", options = {}) {
    super(message, { code: "ERR_DEVICE_NOT_FOUND", status: 404, ...options });
  }
}

/** A device with the same id already exists. */
export class DuplicateDeviceError extends DeviceTrustError {
  constructor(message = "Device already exists", options = {}) {
    super(message, { code: "ERR_DUPLICATE_DEVICE", status: 409, ...options });
  }
}

/** The caller does not own the device. */
export class DeviceOwnershipError extends DeviceTrustError {
  constructor(message = "Device belongs to another user", options = {}) {
    super(message, { code: "ERR_DEVICE_OWNERSHIP", status: 403, ...options });
  }
}

/** An illegal trust-state transition was attempted. */
export class InvalidTrustTransitionError extends DeviceTrustError {
  constructor(message = "Invalid trust transition", options = {}) {
    super(message, { code: "ERR_INVALID_TRUST_TRANSITION", status: 409, ...options });
  }
}

/** A registration rule was violated (e.g. device limit). */
export class RegistrationPolicyError extends DeviceTrustError {
  constructor(message = "Registration policy violation", options = {}) {
    super(message, { code: "ERR_REGISTRATION_POLICY", status: 409, ...options });
  }
}
