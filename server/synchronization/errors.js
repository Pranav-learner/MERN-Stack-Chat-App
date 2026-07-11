/**
 * @module synchronization/errors
 *
 * Typed error hierarchy for the Synchronization Engine (Layer 9, Sprint 1). Every error carries a
 * stable `.code` + HTTP `.status`. Mirrors the data-plane / transport-reliability error style.
 */

export class SyncError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_SYNC";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class ReplicaNotFoundError extends SyncError {
  constructor(message = "Replica not found", options = {}) {
    super(message, { code: "ERR_SYNC_REPLICA_NOT_FOUND", status: 404, ...options });
  }
}

export class SessionNotFoundError extends SyncError {
  constructor(message = "Synchronization session not found", options = {}) {
    super(message, { code: "ERR_SYNC_SESSION_NOT_FOUND", status: 404, ...options });
  }
}

export class InvalidSessionTransitionError extends SyncError {
  constructor(message = "Invalid session transition", options = {}) {
    super(message, { code: "ERR_SYNC_INVALID_TRANSITION", status: 409, ...options });
  }
}

export class MalformedDeltaError extends SyncError {
  constructor(message = "Malformed delta", options = {}) {
    super(message, { code: "ERR_SYNC_MALFORMED_DELTA", status: 422, ...options });
  }
}

export class InvalidPlanError extends SyncError {
  constructor(message = "Invalid synchronization plan", options = {}) {
    super(message, { code: "ERR_SYNC_INVALID_PLAN", status: 422, ...options });
  }
}

export class SessionExpiredError extends SyncError {
  constructor(message = "Synchronization session has expired", options = {}) {
    super(message, { code: "ERR_SYNC_SESSION_EXPIRED", status: 410, ...options });
  }
}

export class UnauthorizedSyncError extends SyncError {
  constructor(message = "Caller is not authorized for this synchronization", options = {}) {
    super(message, { code: "ERR_SYNC_FORBIDDEN", status: 403, ...options });
  }
}

export class SyncValidationError extends SyncError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_SYNC_VALIDATION", status: 400, ...options });
  }
}
