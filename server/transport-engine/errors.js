/**
 * @module transport-engine/errors
 *
 * Typed error hierarchy for the Transport Engine (Layer 8, Sprint 2). Every error carries a stable
 * `.code` + HTTP `.status` so the API layer can map failures without string-matching. Mirrors the
 * data-plane error style.
 */

/** Base class for all transport-engine errors. */
export class TransportEngineError extends Error {
  /** @param {string} message @param {{ code?: string, status?: number, reason?: string, details?: object }} [options] */
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_TRANSPORT";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class TransferNotFoundError extends TransportEngineError {
  constructor(message = "Transfer not found", options = {}) {
    super(message, { code: "ERR_TRANSPORT_TRANSFER_NOT_FOUND", status: 404, ...options });
  }
}

export class ChunkValidationError extends TransportEngineError {
  constructor(message = "Invalid chunk", options = {}) {
    super(message, { code: "ERR_TRANSPORT_CHUNK_INVALID", status: 400, ...options });
  }
}

export class InvalidTransferTransitionError extends TransportEngineError {
  constructor(message = "Invalid transfer transition", options = {}) {
    super(message, { code: "ERR_TRANSPORT_INVALID_TRANSITION", status: 409, ...options });
  }
}

export class TransferCorruptedError extends TransportEngineError {
  constructor(message = "Transfer is corrupted", options = {}) {
    super(message, { code: "ERR_TRANSPORT_CORRUPTED", status: 422, ...options });
  }
}

export class TransferExpiredError extends TransportEngineError {
  constructor(message = "Transfer has expired", options = {}) {
    super(message, { code: "ERR_TRANSPORT_EXPIRED", status: 410, ...options });
  }
}

export class DuplicateChunkError extends TransportEngineError {
  constructor(message = "Duplicate chunk", options = {}) {
    super(message, { code: "ERR_TRANSPORT_DUPLICATE_CHUNK", status: 409, ...options });
  }
}

export class MissingChunkError extends TransportEngineError {
  constructor(message = "Missing chunk(s)", options = {}) {
    super(message, { code: "ERR_TRANSPORT_MISSING_CHUNK", status: 422, ...options });
  }
}

export class BackpressureError extends TransportEngineError {
  constructor(message = "Backpressure limit exceeded", options = {}) {
    super(message, { code: "ERR_TRANSPORT_BACKPRESSURE", status: 429, ...options });
  }
}

export class PayloadTooLargeError extends TransportEngineError {
  constructor(message = "Payload exceeds the maximum size", options = {}) {
    super(message, { code: "ERR_TRANSPORT_PAYLOAD_TOO_LARGE", status: 413, ...options });
  }
}

export class UnauthorizedTransferError extends TransportEngineError {
  constructor(message = "Caller is not authorized for this transfer", options = {}) {
    super(message, { code: "ERR_TRANSPORT_UNAUTHORIZED", status: 403, ...options });
  }
}

export class TransportValidationError extends TransportEngineError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_TRANSPORT_VALIDATION", status: 400, ...options });
  }
}
