/**
 * @module network-discovery/errors
 *
 * Typed error hierarchy for the Network Discovery subsystem (Layer 7, Sprint 1). Each error carries
 * a stable `.code` and HTTP `.status`, in its own `ERR_NETDISC_*` namespace.
 */

/** Base class for all Network Discovery errors. */
export class DiscoveryError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_NETDISC";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A discovery input (ids, interfaces, candidates, config) failed validation. */
export class DiscoveryValidationError extends DiscoveryError {
  constructor(message = "Network discovery validation failed", options = {}) {
    super(message, { code: "ERR_NETDISC_VALIDATION", status: 400, ...options });
  }
}

/** No profile / candidate exists for the requested id. */
export class ProfileNotFoundError extends DiscoveryError {
  constructor(message = "Network profile not found", options = {}) {
    super(message, { code: "ERR_NETDISC_NOT_FOUND", status: 404, ...options });
  }
}

/** A STUN request timed out / no server responded. */
export class StunError extends DiscoveryError {
  /** @param {string} message @param {{reason?:string, status?:number, cause?:unknown, details?:object}} [options] */
  constructor(message = "STUN resolution failed", options = {}) {
    super(message, { code: "ERR_NETDISC_STUN", status: options.status ?? 502, ...options });
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

/** A STUN message could not be encoded/decoded (protocol error). */
export class StunProtocolError extends DiscoveryError {
  constructor(message = "Malformed STUN message", options = {}) {
    super(message, { code: "ERR_NETDISC_STUN_PROTOCOL", status: 502, ...options });
  }
}

/** A network profile outlived its TTL. */
export class ProfileExpiredError extends DiscoveryError {
  constructor(message = "Network profile has expired", options = {}) {
    super(message, { code: "ERR_NETDISC_EXPIRED", status: 410, ...options });
  }
}

/** The caller is not permitted to inspect / mutate this profile. */
export class UnauthorizedDiscoveryError extends DiscoveryError {
  constructor(message = "Unauthorized network discovery request", options = {}) {
    super(message, { code: "ERR_NETDISC_UNAUTHORIZED", status: 403, ...options });
  }
}

/** A profile/candidate is malformed, tampered, or carries forbidden secret material. */
export class CorruptedProfileError extends DiscoveryError {
  constructor(message = "Network profile is corrupted", options = {}) {
    super(message, { code: "ERR_NETDISC_CORRUPTED", status: 422, ...options });
  }
}
