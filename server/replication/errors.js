/**
 * @module replication/errors
 *
 * Typed error hierarchy for the State Replication subsystem (Layer 9, Sprint 2). Every error carries a
 * stable `.code` + HTTP `.status`. Mirrors the synchronization / data-plane error style.
 */

export class ReplicationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_REPLICATION";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class ReplicaNotFoundError extends ReplicationError {
  constructor(message = "Replica not found", options = {}) {
    super(message, { code: "ERR_REPLICATION_NOT_FOUND", status: 404, ...options });
  }
}

export class DuplicateReplicaError extends ReplicationError {
  constructor(message = "Replica already exists", options = {}) {
    super(message, { code: "ERR_REPLICATION_DUPLICATE", status: 409, ...options });
  }
}

export class MergeError extends ReplicationError {
  constructor(message = "Invalid merge", options = {}) {
    super(message, { code: "ERR_REPLICATION_INVALID_MERGE", status: 422, ...options });
  }
}

export class CorruptedDeltaError extends ReplicationError {
  constructor(message = "Corrupted replication delta", options = {}) {
    super(message, { code: "ERR_REPLICATION_CORRUPTED_DELTA", status: 422, ...options });
  }
}

export class ReplayDetectedError extends ReplicationError {
  constructor(message = "Replay detected", options = {}) {
    super(message, { code: "ERR_REPLICATION_REPLAY", status: 409, ...options });
  }
}

export class UnresolvedConflictError extends ReplicationError {
  constructor(message = "Conflict could not be resolved", options = {}) {
    super(message, { code: "ERR_REPLICATION_UNRESOLVED_CONFLICT", status: 409, ...options });
  }
}

export class UnauthorizedReplicationError extends ReplicationError {
  constructor(message = "Caller is not authorized for this replication", options = {}) {
    super(message, { code: "ERR_REPLICATION_FORBIDDEN", status: 403, ...options });
  }
}

export class ReplicationValidationError extends ReplicationError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_REPLICATION_VALIDATION", status: 400, ...options });
  }
}
