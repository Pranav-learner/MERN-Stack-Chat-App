/**
 * @module group-receipts/errors
 *
 * Typed error hierarchy for the Group Delivery Intelligence subsystem (Layer 10, Sprint 4). Every error
 * carries a stable `.code` + HTTP `.status`. Mirrors the group-communication / group-reliability style.
 */

export class GroupReceiptError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_GROUP_RECEIPT";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class ReceiptNotFoundError extends GroupReceiptError {
  constructor(message = "Receipt aggregate not found", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_NOT_FOUND", status: 404, reason: "unknown-message", ...options });
  }
}

export class MemberReceiptNotFoundError extends GroupReceiptError {
  constructor(message = "Member receipt not found", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_MEMBER_NOT_FOUND", status: 404, reason: "unknown-member", ...options });
  }
}

export class DuplicateDeliveryError extends GroupReceiptError {
  constructor(message = "Duplicate delivery", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_DUPLICATE_DELIVERY", status: 409, reason: "duplicate-delivery", ...options });
  }
}

export class DuplicateReadError extends GroupReceiptError {
  constructor(message = "Duplicate read", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_DUPLICATE_READ", status: 409, reason: "duplicate-read", ...options });
  }
}

export class InvalidAggregateError extends GroupReceiptError {
  constructor(message = "Invalid receipt aggregate", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_INVALID_AGGREGATE", status: 422, reason: "invalid-aggregate", ...options });
  }
}

export class InvalidDeliveryTransitionError extends GroupReceiptError {
  constructor(message = "Invalid delivery transition", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_INVALID_TRANSITION", status: 409, reason: "invalid-transition", ...options });
  }
}

export class NotApplicableMemberError extends GroupReceiptError {
  constructor(message = "Member is not applicable for this message's receipt", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_NOT_APPLICABLE", status: 409, reason: "not-applicable", ...options });
  }
}

export class PrivacyPolicyError extends GroupReceiptError {
  constructor(message = "Operation violates the receipt privacy policy", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_PRIVACY", status: 403, reason: "privacy-violation", ...options });
  }
}

export class UnauthorizedReceiptError extends GroupReceiptError {
  constructor(message = "Caller is not authorized for this receipt", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_FORBIDDEN", status: 403, reason: "unauthorized", ...options });
  }
}

export class ReceiptValidationError extends GroupReceiptError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_GROUP_RECEIPT_VALIDATION", status: 400, reason: "malformed-metadata", ...options });
  }
}
