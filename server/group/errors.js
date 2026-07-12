/**
 * @module group/errors
 *
 * Typed error hierarchy for the Group Foundation subsystem (Layer 10, Sprint 1). Every error carries a
 * stable `.code` + HTTP `.status` so the controller can translate a thrown domain error into a precise
 * response without a switch. Mirrors the replication / synchronization error style.
 */

export class GroupError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_GROUP";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class GroupNotFoundError extends GroupError {
  constructor(message = "Group not found", options = {}) {
    super(message, { code: "ERR_GROUP_NOT_FOUND", status: 404, reason: "unknown-group", ...options });
  }
}

export class DuplicateGroupError extends GroupError {
  constructor(message = "Group already exists", options = {}) {
    super(message, { code: "ERR_GROUP_DUPLICATE", status: 409, reason: "duplicate-group", ...options });
  }
}

export class MembershipNotFoundError extends GroupError {
  constructor(message = "Membership not found", options = {}) {
    super(message, { code: "ERR_GROUP_MEMBERSHIP_NOT_FOUND", status: 404, reason: "unknown-member", ...options });
  }
}

export class DuplicateMembershipError extends GroupError {
  constructor(message = "Member already exists in the group", options = {}) {
    super(message, { code: "ERR_GROUP_MEMBERSHIP_DUPLICATE", status: 409, reason: "duplicate-member", ...options });
  }
}

export class DuplicateInvitationError extends GroupError {
  constructor(message = "An invitation for this member is already pending", options = {}) {
    super(message, { code: "ERR_GROUP_INVITATION_DUPLICATE", status: 409, reason: "duplicate-invitation", ...options });
  }
}

export class InvalidStateTransitionError extends GroupError {
  constructor(message = "Invalid membership state transition", options = {}) {
    super(message, { code: "ERR_GROUP_INVALID_TRANSITION", status: 409, reason: "invalid-state-transition", ...options });
  }
}

export class InvalidRoleError extends GroupError {
  constructor(message = "Invalid role", options = {}) {
    super(message, { code: "ERR_GROUP_INVALID_ROLE", status: 400, reason: "invalid-role", ...options });
  }
}

export class OwnershipError extends GroupError {
  constructor(message = "Invalid ownership operation", options = {}) {
    super(message, { code: "ERR_GROUP_OWNERSHIP", status: 409, reason: "invalid-ownership", ...options });
  }
}

export class PermissionDeniedError extends GroupError {
  constructor(message = "Permission denied for this group operation", options = {}) {
    super(message, { code: "ERR_GROUP_PERMISSION_DENIED", status: 403, reason: "permission-denied", ...options });
  }
}

export class UnauthorizedGroupError extends GroupError {
  constructor(message = "Caller is not authorized for this group", options = {}) {
    super(message, { code: "ERR_GROUP_FORBIDDEN", status: 403, reason: "unauthorized", ...options });
  }
}

export class MetadataValidationError extends GroupError {
  constructor(message = "Invalid group metadata", options = {}) {
    super(message, { code: "ERR_GROUP_INVALID_METADATA", status: 422, reason: "invalid-metadata", ...options });
  }
}

export class VersionConflictError extends GroupError {
  constructor(message = "Version conflict", options = {}) {
    super(message, { code: "ERR_GROUP_VERSION_CONFLICT", status: 409, reason: "version-conflict", ...options });
  }
}

export class GroupValidationError extends GroupError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_GROUP_VALIDATION", status: 400, reason: "invalid-metadata", ...options });
  }
}

export class GroupStateError extends GroupError {
  constructor(message = "Group is not in an operable state", options = {}) {
    super(message, { code: "ERR_GROUP_STATE", status: 409, reason: "group-not-active", ...options });
  }
}
