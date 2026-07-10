/**
 * @module shs/session/rekey
 *
 * A reusable **rekey framework**. It defines the interface, metadata, version
 * tracking, and events for rotating a session's keys — but deliberately does NOT
 * implement Forward Secrecy or a message ratchet. **Layer 5 will extend this
 * framework** by supplying a ratcheting strategy.
 *
 * The default {@link hkdfGenerationStrategy} re-derives session keys from the SAME
 * device-local shared secret with an incremented `generation` counter baked into the
 * HKDF context. This is a deterministic rotation (both peers can rekey to the same
 * new keys independently) — it is **NOT forward-secret**, because the new keys are
 * still a function of the original root secret. That property is intentionally left
 * for Layer 5.
 *
 * @security Strategies receive and return device-local key material; nothing here is
 * serialized or transmitted. The manager records only rekey METADATA (generation,
 * timestamp, reason) on the session.
 */

import { deriveSessionKeys } from "../derivation/sessionKeys.js";
import { RekeyError } from "../errors.js";

/**
 * @typedef {object} RekeyContext
 * @property {object} session the current session record
 * @property {object} currentKeys the current {@link SessionKeys}
 * @property {Buffer} sharedSecret the device-local originating shared secret
 * @property {number} nextGeneration the generation to derive
 * @property {object} derivationContext `{ handshakeId, participants, deviceIds, protocolVersion }`
 */

/**
 * @callback RekeyStrategy
 * @param {RekeyContext} context
 * @returns {object} the new {@link SessionKeys}
 */

/**
 * The default rekey strategy: HKDF re-derivation at the next generation from the same
 * root shared secret. Deterministic; NOT forward-secret (Layer 5 replaces this).
 * @type {RekeyStrategy}
 */
export const hkdfGenerationStrategy = ({ sharedSecret, nextGeneration, derivationContext }) => {
  if (!sharedSecret) throw new RekeyError("hkdfGenerationStrategy requires the device-local shared secret");
  return deriveSessionKeys(sharedSecret, derivationContext, { generation: nextGeneration });
};

/** Registry of named strategies. Layer 5 registers a ratchet strategy here. */
export const REKEY_STRATEGIES = Object.freeze({
  "hkdf-generation": hkdfGenerationStrategy,
});

/**
 * Resolve a rekey strategy by name or accept a function directly.
 * @param {string|RekeyStrategy} [strategy="hkdf-generation"]
 * @returns {RekeyStrategy}
 */
export function resolveStrategy(strategy = "hkdf-generation") {
  if (typeof strategy === "function") return strategy;
  const resolved = REKEY_STRATEGIES[strategy];
  if (!resolved) throw new RekeyError(`Unknown rekey strategy: ${strategy}`, { details: { strategy } });
  return resolved;
}

/**
 * Build the rekey-history entry recorded on a session after a successful rekey.
 * @param {{ generation: number, reason?: string, strategy?: string, at?: number }} params
 */
export function rekeyRecord(params) {
  return {
    generation: params.generation,
    reason: params.reason ?? "manual",
    strategy: params.strategy ?? "hkdf-generation",
    at: new Date(params.at ?? Date.now()).toISOString(),
  };
}

/**
 * Whether a rekey is permitted for a session state. Rekeying only makes sense on an
 * active-family session.
 * @param {object} session @returns {boolean}
 */
export function canRekey(session) {
  return ["active", "idle", "paused", "resumed"].includes(session?.status);
}
