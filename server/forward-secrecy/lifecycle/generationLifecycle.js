/**
 * @module forward-secrecy/lifecycle
 *
 * The deterministic lifecycle of a single cryptographic **generation**, plus the
 * forward-only ordering rules that make rollback impossible.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> pending : derived
 *   pending --> active : activate
 *   pending --> destroyed : failed evolution
 *   active --> superseded : newer generation activated
 *   superseded --> expired : aged out of retain window
 *   superseded --> destroyed
 *   expired --> destroyed
 *   active --> destroyed : session ended
 *   destroyed --> [*]
 * ```
 *
 * @security Rollback prevention is enforced here: a generation may only ever ADVANCE
 * (`n → n+1`). {@link assertForwardOnly} rejects any attempt to activate a generation
 * less than or equal to the current one — the defence against a downgrade/rollback attack.
 */

import { GenerationStatus } from "../types/types.js";
import { GenerationOrderingError, RollbackDetectedError } from "../errors.js";

/** Legal generation-status transitions. @type {Readonly<Record<string,string[]>>} */
export const ALLOWED_GENERATION_TRANSITIONS = Object.freeze({
  [GenerationStatus.PENDING]: [GenerationStatus.ACTIVE, GenerationStatus.DESTROYED],
  [GenerationStatus.ACTIVE]: [GenerationStatus.SUPERSEDED, GenerationStatus.DESTROYED],
  [GenerationStatus.SUPERSEDED]: [GenerationStatus.EXPIRED, GenerationStatus.DESTROYED],
  [GenerationStatus.EXPIRED]: [GenerationStatus.DESTROYED],
  [GenerationStatus.DESTROYED]: [],
});

/** Whether a generation-status transition is legal. @returns {boolean} */
export function canGenerationTransition(from, to) {
  return (ALLOWED_GENERATION_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a generation-status transition is legal. @throws {GenerationOrderingError} */
export function assertGenerationTransition(from, to) {
  if (!canGenerationTransition(from, to)) {
    throw new GenerationOrderingError(`Illegal generation transition "${from}" → "${to}"`, {
      details: { from, to, allowed: ALLOWED_GENERATION_TRANSITIONS[from] ?? [] },
    });
  }
}

/**
 * Assert a proposed generation strictly advances the current one by exactly +1.
 * Rejects gaps ({@link GenerationOrderingError}) and rollbacks/replays
 * ({@link RollbackDetectedError}).
 * @param {number} current @param {number} next @throws {GenerationOrderingError|RollbackDetectedError}
 */
export function assertForwardOnly(current, next) {
  if (!Number.isInteger(current) || !Number.isInteger(next)) {
    throw new GenerationOrderingError("Generation numbers must be integers", { details: { current, next } });
  }
  if (next <= current) {
    throw new RollbackDetectedError(`Refusing to evolve to generation ${next} (current is ${current}); forward-only`, {
      details: { current, next },
    });
  }
  if (next !== current + 1) {
    throw new GenerationOrderingError(`Generation must advance by exactly one (expected ${current + 1}, got ${next})`, {
      details: { current, next, expected: current + 1 },
    });
  }
}

export { GenerationStatus };
