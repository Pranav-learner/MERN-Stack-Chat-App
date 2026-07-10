/**
 * @module session-evolution/errors
 *
 * Typed error hierarchy for the Session Evolution Framework (Layer 5, Sprint 1). Each
 * error carries a stable `.code` and HTTP `.status`, in its own `ERR_EVOLUTION_*`
 * namespace — distinct from Secure Session (`ERR_SESSION_*`), SHS (`ERR_SHS_*`),
 * key-agreement (`ERR_KA_*`), and transport (`ERR_TRANSPORT_*`) errors.
 */

/** Base class for all Session Evolution errors. */
export class EvolutionError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_EVOLUTION";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** An evolution input (ids, generation, request shape) failed validation. */
export class EvolutionValidationError extends EvolutionError {
  constructor(message = "Evolution validation failed", options = {}) {
    super(message, { code: "ERR_EVOLUTION_VALIDATION", status: 400, ...options });
  }
}

/** No evolution record exists for the requested session/evolution id. */
export class EvolutionNotFoundError extends EvolutionError {
  constructor(message = "Evolution state not found", options = {}) {
    super(message, { code: "ERR_EVOLUTION_NOT_FOUND", status: 404, ...options });
  }
}

/** An evolution record already exists for a session that may have only one. */
export class DuplicateEvolutionError extends EvolutionError {
  constructor(message = "An evolution state already exists for this session", options = {}) {
    super(message, { code: "ERR_EVOLUTION_DUPLICATE", status: 409, ...options });
  }
}

/** An illegal evolution-state transition was attempted. */
export class InvalidEvolutionTransitionError extends EvolutionError {
  constructor(message = "Invalid evolution state transition", options = {}) {
    super(message, { code: "ERR_EVOLUTION_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** A generation number is invalid (negative, non-integer) or advances incorrectly. */
export class InvalidGenerationError extends EvolutionError {
  constructor(message = "Invalid generation number", options = {}) {
    super(message, { code: "ERR_EVOLUTION_INVALID_GENERATION", status: 409, ...options });
  }
}

/** A generation that already exists in the timeline was produced again. */
export class DuplicateGenerationError extends EvolutionError {
  constructor(message = "Duplicate generation number", options = {}) {
    super(message, { code: "ERR_EVOLUTION_DUPLICATE_GENERATION", status: 409, ...options });
  }
}

/** Evolution metadata is malformed, tampered, or carries forbidden key material. */
export class CorruptedEvolutionMetadataError extends EvolutionError {
  constructor(message = "Evolution metadata is corrupted", options = {}) {
    super(message, { code: "ERR_EVOLUTION_CORRUPTED_METADATA", status: 422, ...options });
  }
}

/** A policy descriptor is malformed or two policies conflict. */
export class PolicyConflictError extends EvolutionError {
  constructor(message = "Evolution policy conflict", options = {}) {
    super(message, { code: "ERR_EVOLUTION_POLICY_CONFLICT", status: 409, ...options });
  }
}

/** An operation was attempted on a retired (terminal) evolution record. */
export class EvolutionRetiredError extends EvolutionError {
  constructor(message = "Evolution tracking has been retired for this session", options = {}) {
    super(message, { code: "ERR_EVOLUTION_RETIRED", status: 410, ...options });
  }
}
