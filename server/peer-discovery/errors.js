/**
 * @module peer-discovery/errors
 *
 * Typed error hierarchy for the Peer Discovery Framework (Layer 6, Sprint 1). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_DISCOVERY_*` namespace —
 * distinct from identity (`ERR_IDENTITY_*`), session (`ERR_SESSION_*`), evolution
 * (`ERR_EVOLUTION_*`), and transport (`ERR_TRANSPORT_*`) errors.
 */

/** Base class for all Peer Discovery errors. */
export class DiscoveryError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_DISCOVERY";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A discovery input (ids, request shape, lookup type) failed validation. */
export class DiscoveryValidationError extends DiscoveryError {
  constructor(message = "Discovery validation failed", options = {}) {
    super(message, { code: "ERR_DISCOVERY_VALIDATION", status: 400, ...options });
  }
}

/** No discovery session exists for the requested id. */
export class DiscoveryNotFoundError extends DiscoveryError {
  constructor(message = "Discovery session not found", options = {}) {
    super(message, { code: "ERR_DISCOVERY_NOT_FOUND", status: 404, ...options });
  }
}

/** The target user has no discoverable identity/registry entry. */
export class UnknownUserError extends DiscoveryError {
  constructor(message = "Unknown user", options = {}) {
    super(message, { code: "ERR_DISCOVERY_UNKNOWN_USER", status: 404, ...options });
  }
}

/** The requested device is unknown or not discoverable for the user. */
export class UnknownDeviceError extends DiscoveryError {
  constructor(message = "Unknown device", options = {}) {
    super(message, { code: "ERR_DISCOVERY_UNKNOWN_DEVICE", status: 404, ...options });
  }
}

/** An identical discovery request is already in flight (deduplicated). */
export class DuplicateDiscoveryError extends DiscoveryError {
  constructor(message = "A matching discovery request is already in progress", options = {}) {
    super(message, { code: "ERR_DISCOVERY_DUPLICATE", status: 409, ...options });
  }
}

/** An illegal discovery-state transition was attempted. */
export class InvalidDiscoveryTransitionError extends DiscoveryError {
  constructor(message = "Invalid discovery state transition", options = {}) {
    super(message, { code: "ERR_DISCOVERY_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** A discovery session outlived its TTL. */
export class DiscoveryExpiredError extends DiscoveryError {
  constructor(message = "Discovery session has expired", options = {}) {
    super(message, { code: "ERR_DISCOVERY_EXPIRED", status: 410, ...options });
  }
}

/** The caller is not permitted to perform / inspect this discovery. */
export class UnauthorizedDiscoveryError extends DiscoveryError {
  constructor(message = "Unauthorized discovery request", options = {}) {
    super(message, { code: "ERR_DISCOVERY_UNAUTHORIZED", status: 403, ...options });
  }
}

/** Discovery metadata is malformed, tampered, or carries forbidden secret material. */
export class CorruptedDiscoveryMetadataError extends DiscoveryError {
  constructor(message = "Discovery metadata is corrupted", options = {}) {
    super(message, { code: "ERR_DISCOVERY_CORRUPTED_METADATA", status: 422, ...options });
  }
}

/** The authoritative identity/device directory could not be reached. */
export class DirectoryUnavailableError extends DiscoveryError {
  constructor(message = "Discovery directory is unavailable", options = {}) {
    super(message, { code: "ERR_DISCOVERY_DIRECTORY_UNAVAILABLE", status: 503, ...options });
  }
}
