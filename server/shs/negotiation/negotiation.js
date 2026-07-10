/**
 * @module shs/negotiation
 *
 * Version + capability negotiation for the Secure Handshake Protocol. Given two
 * parties' advertised versions and capability lists, it computes the agreed
 * protocol version and the effective (intersected) capability set.
 *
 * Negotiation here is about PROTOCOL FEATURES ("does the peer support resume?"),
 * NOT cryptographic suite selection — that is a future sprint. Nothing negotiated
 * in Sprint 1 selects a cipher or exchanges keys.
 *
 * @example
 * ```js
 * const result = negotiate(
 *   { version: "1.0", capabilities: ["handshake.resume", "handshake.retry"] },
 *   { version: "1.0", capabilities: ["handshake.resume"] },
 * );
 * result.version;      // "1.0"
 * result.capabilities; // ["handshake.resume"]
 * ```
 */

import { negotiateVersion, featuresForVersion } from "../protocol/version.js";
import { NegotiationError } from "../errors.js";

/**
 * @typedef {object} PartyOffer
 * @property {string} version the party's protocol version
 * @property {string[]} [capabilities] the party's advertised capabilities
 */

/**
 * @typedef {object} NegotiationResult
 * @property {string} version the agreed protocol version
 * @property {string[]} capabilities the intersected, version-valid capability set
 * @property {string[]} rejected capabilities offered by one side but not agreed
 */

/**
 * Negotiate the effective protocol between an initiator and a responder.
 *
 * @param {PartyOffer} initiator
 * @param {PartyOffer} responder
 * @param {{ required?: string[] }} [options] capabilities that MUST be in the
 *   agreed set, else negotiation fails
 * @returns {NegotiationResult}
 * @throws {ProtocolVersionError} if versions are incompatible
 * @throws {NegotiationError} if a required capability is unmet
 */
export function negotiate(initiator, responder, options = {}) {
  const version = negotiateVersion(initiator.version, responder.version);

  // A capability is only valid if the agreed version actually offers it.
  const versionFeatures = new Set(featuresForVersion(version));
  const initCaps = new Set(initiator.capabilities ?? []);
  const respCaps = new Set(responder.capabilities ?? []);

  const agreed = [];
  const rejected = new Set();
  for (const cap of new Set([...initCaps, ...respCaps])) {
    const mutual = initCaps.has(cap) && respCaps.has(cap) && versionFeatures.has(cap);
    if (mutual) agreed.push(cap);
    else rejected.add(cap);
  }

  const required = options.required ?? [];
  const missing = required.filter((cap) => !agreed.includes(cap));
  if (missing.length > 0) {
    throw new NegotiationError(`Required capabilities not agreed: ${missing.join(", ")}`, {
      details: { missing, agreed, version },
    });
  }

  return { version, capabilities: agreed.sort(), rejected: [...rejected].sort() };
}

/**
 * Whether two parties can negotiate at all (compatible version + all required
 * capabilities available). Non-throwing convenience wrapper.
 * @param {PartyOffer} initiator @param {PartyOffer} responder @param {{ required?: string[] }} [options]
 * @returns {boolean}
 */
export function canNegotiate(initiator, responder, options = {}) {
  try {
    negotiate(initiator, responder, options);
    return true;
  } catch {
    return false;
  }
}
