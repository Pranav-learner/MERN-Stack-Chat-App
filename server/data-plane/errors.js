/**
 * @module data-plane/errors
 *
 * Typed error hierarchy for the Reliable Messaging Engine (Layer 8, Sprint 1). Each error carries a
 * stable `.code` and HTTP `.status`, in its own `ERR_DATAPLANE_*` namespace.
 */

/** Base class for all data-plane errors. */
export class DataPlaneError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_DATAPLANE";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A message/ack input (ids, payload, sequence) failed validation. */
export class MessageValidationError extends DataPlaneError {
  constructor(message = "Message validation failed", options = {}) {
    super(message, { code: "ERR_DATAPLANE_VALIDATION", status: 400, ...options });
  }
}

/** No message exists for the requested id. */
export class MessageNotFoundError extends DataPlaneError {
  constructor(message = "Message not found", options = {}) {
    super(message, { code: "ERR_DATAPLANE_NOT_FOUND", status: 404, ...options });
  }
}

/** A duplicate message/ack was detected (idempotent no-op, surfaced when relevant). */
export class DuplicateMessageError extends DataPlaneError {
  constructor(message = "Duplicate message", options = {}) {
    super(message, { code: "ERR_DATAPLANE_DUPLICATE", status: 409, ...options });
  }
}

/** An illegal delivery-state transition was attempted. */
export class InvalidDeliveryTransitionError extends DataPlaneError {
  constructor(message = "Invalid delivery state transition", options = {}) {
    super(message, { code: "ERR_DATAPLANE_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** A message outlived its TTL. */
export class MessageExpiredError extends DataPlaneError {
  constructor(message = "Message has expired", options = {}) {
    super(message, { code: "ERR_DATAPLANE_EXPIRED", status: 410, ...options });
  }
}

/** The caller is not the authorized sender/owner of the message/conversation. */
export class UnauthorizedSenderError extends DataPlaneError {
  constructor(message = "Unauthorized sender", options = {}) {
    super(message, { code: "ERR_DATAPLANE_UNAUTHORIZED", status: 403, ...options });
  }
}

/** No live Active Connection is available to transport the message. */
export class NoConnectionError extends DataPlaneError {
  constructor(message = "No live connection to the peer", options = {}) {
    super(message, { code: "ERR_DATAPLANE_NO_CONNECTION", status: 503, ...options });
  }
}

/** A message/ack is malformed, tampered, or carries forbidden plaintext / secret material. */
export class CorruptedMessageError extends DataPlaneError {
  constructor(message = "Message is corrupted", options = {}) {
    super(message, { code: "ERR_DATAPLANE_CORRUPTED", status: 422, ...options });
  }
}
