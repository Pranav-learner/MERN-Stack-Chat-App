/**
 * @module message-keys/lifecycle
 *
 * The deterministic lifecycle of a single message key.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> derived
 *   derived --> active : use
 *   derived --> cached : skipped (out of order)
 *   derived --> failed : derivation/validation error
 *   active --> used : encrypt/decrypt ok
 *   used --> destroyed : wipe (immediate)
 *   cached --> active : the awaited message arrives
 *   cached --> expired : aged out
 *   active --> failed
 *   failed --> destroyed
 *   expired --> destroyed
 *   destroyed --> [*]
 * ```
 *
 * @security A message key is USED for exactly one encrypt/decrypt, then DESTROYED
 * immediately. A cached (skipped) key is still secret and is destroyed on use or expiry.
 */

import { MessageKeyState } from "../types/types.js";
import { MessageKeyValidationError } from "../errors.js";

/** Legal message-key state transitions. @type {Readonly<Record<string,string[]>>} */
export const ALLOWED_MESSAGE_KEY_TRANSITIONS = Object.freeze({
  [MessageKeyState.DERIVED]: [MessageKeyState.ACTIVE, MessageKeyState.CACHED, MessageKeyState.FAILED, MessageKeyState.DESTROYED],
  [MessageKeyState.ACTIVE]: [MessageKeyState.USED, MessageKeyState.FAILED],
  [MessageKeyState.CACHED]: [MessageKeyState.ACTIVE, MessageKeyState.EXPIRED, MessageKeyState.DESTROYED],
  [MessageKeyState.USED]: [MessageKeyState.DESTROYED],
  [MessageKeyState.EXPIRED]: [MessageKeyState.DESTROYED],
  [MessageKeyState.FAILED]: [MessageKeyState.DESTROYED],
  [MessageKeyState.DESTROYED]: [],
});

/** Whether `from -> to` is legal. @returns {boolean} */
export function canTransition(from, to) {
  return (ALLOWED_MESSAGE_KEY_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {MessageKeyValidationError} */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new MessageKeyValidationError(`Illegal message-key transition "${from}" → "${to}"`, {
      details: { from, to, allowed: ALLOWED_MESSAGE_KEY_TRANSITIONS[from] ?? [] },
    });
  }
}

/** Whether a state means the key bytes are gone. */
export function isTerminal(state) {
  return state === MessageKeyState.DESTROYED;
}

export { MessageKeyState };
