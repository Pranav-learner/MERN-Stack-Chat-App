/**
 * @module group-communication/errors
 *
 * Typed error hierarchy for the Group Communication Engine (Layer 10, Sprint 2). Every error carries a
 * stable `.code` + HTTP `.status`. Mirrors the Sprint-1 group / Layer 9 error style.
 */

export class GroupCommError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_GROUP_COMM";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class GroupNotFoundError extends GroupCommError {
  constructor(message = "Group not found", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_GROUP_NOT_FOUND", status: 404, reason: "unknown-group", ...options });
  }
}

export class GroupKeyNotFoundError extends GroupCommError {
  constructor(message = "Group key not found", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_KEY_NOT_FOUND", status: 404, reason: "unknown-key", ...options });
  }
}

export class InvalidGroupKeyError extends GroupCommError {
  constructor(message = "Invalid group key", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_INVALID_KEY", status: 422, reason: "invalid-key", ...options });
  }
}

export class ExpiredGroupKeyError extends GroupCommError {
  constructor(message = "Group key has expired", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_EXPIRED_KEY", status: 409, reason: "expired-key", ...options });
  }
}

export class StaleKeyVersionError extends GroupCommError {
  constructor(message = "Stale group key version", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_STALE_KEY_VERSION", status: 409, reason: "stale-key-version", ...options });
  }
}

export class UnauthorizedMemberError extends GroupCommError {
  constructor(message = "Caller is not an authorized member of this group", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_UNAUTHORIZED_MEMBER", status: 403, reason: "unauthorized-member", ...options });
  }
}

export class InvalidFanoutPlanError extends GroupCommError {
  constructor(message = "Invalid fan-out plan", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_INVALID_FANOUT", status: 422, reason: "invalid-fanout-plan", ...options });
  }
}

export class ReplicaMismatchError extends GroupCommError {
  constructor(message = "Group replica mismatch", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_REPLICA_MISMATCH", status: 409, reason: "replica-mismatch", ...options });
  }
}

export class SynchronizationError extends GroupCommError {
  constructor(message = "Group synchronization failed", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_SYNC", status: 409, reason: "sync-failure", ...options });
  }
}

export class DuplicateDeliveryError extends GroupCommError {
  constructor(message = "Duplicate delivery", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_DUPLICATE_DELIVERY", status: 409, reason: "duplicate-delivery", ...options });
  }
}

export class UnauthorizedGroupCommError extends GroupCommError {
  constructor(message = "Caller is not authorized for this operation", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_FORBIDDEN", status: 403, reason: "unauthorized", ...options });
  }
}

export class GroupCommValidationError extends GroupCommError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_GROUP_COMM_VALIDATION", status: 400, reason: "malformed-payload", ...options });
  }
}
