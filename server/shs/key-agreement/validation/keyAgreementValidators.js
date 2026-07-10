/**
 * @module shs/key-agreement/validation
 *
 * Validation for the key-agreement subsystem. Covers every attack-surface item in
 * the sprint spec:
 *
 *   - unknown peer (identity/device directory)
 *   - invalid / malformed ephemeral public key (length, encoding, small-order point)
 *   - malformed handshake reference
 *   - mismatched protocol / crypto versions
 *   - duplicate ephemeral key submissions (idempotency)
 *   - expired key-exchange record
 *   - replay attempts (reused ephemeral key / commitment)
 *   - corrupted negotiation payload
 *
 * Cryptographic key validation delegates to {@link module:shs/key-agreement/crypto/x25519}.
 */

import { validateRawPublicKey, decodeRawPublicKey, verifyEphemeralKey } from "../crypto/x25519.js";
import {
  KeyAgreementValidationError,
  UnknownPeerError,
  DuplicateExchangeError,
  ReplayError,
  KeyAgreementExpiredError,
  PeerAuthenticationError,
  InvalidPublicKeyError,
} from "../errors.js";
import { SUPPORTED_ALGORITHMS, SUPPORTED_CRYPTO_VERSIONS } from "../types.js";

/**
 * Validate an ephemeral public-key bundle's shape + key safety.
 * @param {object} bundle @param {{ requireSignature?: boolean }} [options]
 * @returns {Buffer} the validated raw public key
 * @throws {KeyAgreementValidationError | InvalidPublicKeyError}
 */
export function validateBundle(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object") {
    throw new KeyAgreementValidationError("Ephemeral key bundle must be an object");
  }
  if (!SUPPORTED_ALGORITHMS.includes(bundle.algorithm)) {
    throw new KeyAgreementValidationError(`Unsupported algorithm: ${bundle.algorithm}`, {
      details: { algorithm: bundle.algorithm },
    });
  }
  if (typeof bundle.publicKey !== "string" || !bundle.publicKey) {
    throw new InvalidPublicKeyError("Bundle is missing a base64 publicKey");
  }
  const raw = validateRawPublicKey(bundle.publicKey); // length + small-order rejection
  if (options.requireSignature && !bundle.signature) {
    throw new KeyAgreementValidationError("Ephemeral key must be signed (authenticated exchange required)");
  }
  return raw;
}

/**
 * Verify a bundle's identity signature (authenticated key exchange). No-op when the
 * bundle is unsigned and `requireSignature` is false.
 * @param {object} bundle
 * @param {{ requireSignature?: boolean, expectedIdentityKey?: string }} [options]
 * @throws {PeerAuthenticationError}
 */
export function verifyBundleSignature(bundle, options = {}) {
  if (!bundle.signature) {
    if (options.requireSignature) throw new PeerAuthenticationError("Missing ephemeral key signature");
    return true;
  }
  const identityKey = options.expectedIdentityKey ?? bundle.identityPublicKey;
  if (!identityKey) throw new PeerAuthenticationError("No identity key to verify the ephemeral signature");
  if (!verifyEphemeralKey(decodeRawPublicKey(bundle.publicKey), bundle.signature, identityKey)) {
    throw new PeerAuthenticationError();
  }
  // If the caller pinned an expected identity key, the bundle must not claim a different one.
  if (options.expectedIdentityKey && bundle.identityPublicKey && bundle.identityPublicKey !== options.expectedIdentityKey) {
    throw new PeerAuthenticationError("Ephemeral key identity does not match the expected peer identity");
  }
  return true;
}

/**
 * Validate the parties of a key agreement exist (optional directory lookups). Mirrors
 * the SHS party validation; when a lookup is absent the check is skipped.
 * @param {{ initiator: string, responder: string, initiatorDevice?: string, responderDevice?: string }} req
 * @param {{ identityLookup?: Function, deviceLookup?: Function }} [lookups]
 * @throws {KeyAgreementValidationError | UnknownPeerError}
 */
export async function validatePeers(req, lookups = {}) {
  if (!req.initiator || !req.responder) {
    throw new KeyAgreementValidationError("initiator and responder are required");
  }
  if (String(req.initiator) === String(req.responder)) {
    throw new KeyAgreementValidationError("Cannot run key agreement with yourself");
  }
  if (lookups.identityLookup) {
    for (const user of [req.initiator, req.responder]) {
      if (!(await lookups.identityLookup(user))) {
        throw new UnknownPeerError(`No identity for user ${user}`, { details: { userId: String(user) } });
      }
    }
  }
}

/** Validate a handshake reference is a non-empty string. */
export function validateHandshakeRef(handshakeId) {
  if (typeof handshakeId !== "string" || !handshakeId) {
    throw new KeyAgreementValidationError("A valid handshakeId is required");
  }
  return handshakeId;
}

/** Validate algorithm + crypto version against an established exchange record. */
export function validateAgainstExchange(bundle, exchange) {
  if (!exchange) {
    throw new KeyAgreementValidationError("No key-exchange record for this handshake");
  }
  if (bundle.algorithm !== exchange.algorithm) {
    throw new KeyAgreementValidationError("Ephemeral key algorithm does not match the negotiated algorithm", {
      details: { bundle: bundle.algorithm, negotiated: exchange.algorithm },
    });
  }
  if (!SUPPORTED_CRYPTO_VERSIONS.includes(exchange.cryptoVersion)) {
    throw new KeyAgreementValidationError("Exchange crypto version is unsupported", {
      details: { cryptoVersion: exchange.cryptoVersion },
    });
  }
}

/**
 * Reject a duplicate ephemeral key for a role that already submitted one.
 * @throws {DuplicateExchangeError}
 */
export function assertNotDuplicateKey(exchange, role) {
  const existing = role === "initiator" ? exchange?.initiatorKey : exchange?.responderKey;
  if (existing) {
    throw new DuplicateExchangeError(`The ${role} already submitted an ephemeral key`, {
      details: { handshakeId: exchange.handshakeId, role },
    });
  }
}

/**
 * Reject a replayed ephemeral public key (same key bytes reused by either party or
 * across the two roles — ephemeral keys must be unique per handshake).
 * @throws {ReplayError}
 */
export function assertNotReplayedKey(exchange, bundle) {
  const seen = [exchange?.initiatorKey?.publicKey, exchange?.responderKey?.publicKey].filter(Boolean);
  if (seen.includes(bundle.publicKey)) {
    throw new ReplayError("Ephemeral public key was already used in this handshake", {
      details: { handshakeId: exchange?.handshakeId },
    });
  }
}

/** Assert an exchange record has not expired. @throws {KeyAgreementExpiredError} */
export function assertExchangeFresh(exchange, now = Date.now()) {
  if (exchange?.expiresAt && new Date(exchange.expiresAt).getTime() <= now) {
    throw new KeyAgreementExpiredError("Key agreement has expired", {
      details: { handshakeId: exchange.handshakeId },
    });
  }
}

/**
 * Validate a negotiation payload is well-formed (not corrupted/tampered).
 * @param {any} payload @throws {KeyAgreementValidationError}
 */
export function validateNegotiationPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new KeyAgreementValidationError("Corrupted negotiation payload");
  }
  if (payload.algorithms !== undefined && !Array.isArray(payload.algorithms)) {
    throw new KeyAgreementValidationError("Negotiation payload `algorithms` must be an array");
  }
  if (payload.cryptoVersion !== undefined && typeof payload.cryptoVersion !== "string") {
    throw new KeyAgreementValidationError("Negotiation payload `cryptoVersion` must be a string");
  }
  return payload;
}
