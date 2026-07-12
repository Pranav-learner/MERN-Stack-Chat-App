/**
 * @module media-delivery/errors
 *
 * Typed error hierarchy for the Media Delivery subsystem (Layer 11, Sprint 2). Every error carries a
 * stable `.code` + HTTP `.status`. Mirrors the media / group error style.
 */

export class MediaDeliveryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_MEDIA_DELIVERY";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class MediaNotFoundError extends MediaDeliveryError {
  constructor(message = "Media not found", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_MEDIA_NOT_FOUND", status: 404, reason: "unknown-media", ...options });
  }
}

export class SessionNotFoundError extends MediaDeliveryError {
  constructor(message = "Streaming session not found", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_SESSION_NOT_FOUND", status: 404, reason: "unknown-session", ...options });
  }
}

export class TransferNotFoundError extends MediaDeliveryError {
  constructor(message = "Transfer not found", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_TRANSFER_NOT_FOUND", status: 404, reason: "unknown-transfer", ...options });
  }
}

export class InvalidTransitionError extends MediaDeliveryError {
  constructor(message = "Invalid state transition", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_INVALID_TRANSITION", status: 409, reason: "invalid-transition", ...options });
  }
}

export class InvalidRangeError extends MediaDeliveryError {
  constructor(message = "Invalid chunk range", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_INVALID_RANGE", status: 416, reason: "invalid-range", ...options });
  }
}

export class StreamingError extends MediaDeliveryError {
  constructor(message = "Streaming failure", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_STREAMING", status: 422, reason: "streaming-failure", ...options });
  }
}

export class SynchronizationError extends MediaDeliveryError {
  constructor(message = "Media synchronization failed", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_SYNC", status: 409, reason: "sync-failure", ...options });
  }
}

export class PreviewError extends MediaDeliveryError {
  constructor(message = "Preview generation failed", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_PREVIEW", status: 422, reason: "corrupted-preview", ...options });
  }
}

export class IntegrityError extends MediaDeliveryError {
  constructor(message = "Chunk integrity verification failed", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_INTEGRITY", status: 422, reason: "integrity-failure", ...options });
  }
}

export class UnauthorizedDeliveryError extends MediaDeliveryError {
  constructor(message = "Caller is not authorized for this delivery", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_FORBIDDEN", status: 403, reason: "unauthorized", ...options });
  }
}

export class DeliveryValidationError extends MediaDeliveryError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_MEDIA_DELIVERY_VALIDATION", status: 400, reason: "malformed-metadata", ...options });
  }
}
