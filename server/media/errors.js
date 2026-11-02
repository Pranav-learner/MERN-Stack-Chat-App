/**
 * @module media/errors
 *
 * Typed error hierarchy for the Secure Media Platform (Layer 11, Sprint 1). Every error carries a
 * stable `.code` + HTTP `.status`.
 */

export class MediaError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_MEDIA";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class MediaNotFoundError extends MediaError {
  constructor(message = "Media not found", options = {}) {
    super(message, { code: "ERR_MEDIA_NOT_FOUND", status: 404, reason: "unknown-media", ...options });
  }
}

export class MediaValidationError extends MediaError {
  constructor(message = "Invalid media payload", options = {}) {
    super(message, { code: "ERR_MEDIA_VALIDATION", status: 400, reason: "validation-failed", ...options });
  }
}

export class MediaIntegrityError extends MediaError {
  constructor(message = "Media integrity check failed", options = {}) {
    super(message, { code: "ERR_MEDIA_INTEGRITY", status: 422, reason: "integrity-mismatch", ...options });
  }
}

export class MediaOperationNotFoundError extends MediaError {
  constructor(message = "Media operation not found", options = {}) {
    super(message, { code: "ERR_MEDIA_OPERATION_NOT_FOUND", status: 404, reason: "unknown-operation", ...options });
  }
}

export class MediaAuthorizationError extends MediaError {
  constructor(message = "Not authorized to access media", options = {}) {
    super(message, { code: "ERR_MEDIA_UNAUTHORIZED", status: 403, reason: "unauthorized", ...options });
  }
}
