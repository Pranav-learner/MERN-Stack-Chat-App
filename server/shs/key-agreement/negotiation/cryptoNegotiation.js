/**
 * @module shs/key-agreement/negotiation
 *
 * Cryptographic capability negotiation for key agreement. Sits ON TOP of the Sprint 1
 * SHS version negotiation (which agrees the handshake protocol version) and adds:
 *
 *   - **Algorithm negotiation** — pick the most-preferred mutually-supported
 *     key-agreement algorithm (Sprint 2: X25519).
 *   - **Crypto protocol version negotiation** — agree a key-agreement protocol
 *     version, independent of the handshake version.
 *   - **Capability / compatibility validation** — reject when there is no overlap.
 *
 * @security Negotiation selects only PUBLIC parameters (algorithm name, version). It
 * exchanges no keys and derives no secrets.
 */

import {
  SUPPORTED_ALGORITHMS,
  SUPPORTED_CRYPTO_VERSIONS,
  CRYPTO_PROTOCOL_VERSION,
  MIN_CRYPTO_PROTOCOL_VERSION,
} from "../types.js";
import { CryptoNegotiationError } from "../errors.js";

/**
 * @typedef {object} CryptoOffer
 * @property {string[]} [algorithms] supported algorithms, most-preferred first
 * @property {string} [cryptoVersion] the party's crypto protocol version
 */

/**
 * @typedef {object} CryptoNegotiationResult
 * @property {string} algorithm the agreed key-agreement algorithm
 * @property {string} cryptoVersion the agreed crypto protocol version
 * @property {string[]} rejectedAlgorithms algorithms offered but not mutually supported
 */

/**
 * Negotiate the key-agreement algorithm + crypto version between two parties.
 * Preference follows the INITIATOR's ordering (first mutually-supported wins).
 *
 * @param {CryptoOffer} initiator @param {CryptoOffer} responder
 * @param {{ supportedAlgorithms?: string[], supportedVersions?: string[] }} [options]
 * @returns {CryptoNegotiationResult}
 * @throws {CryptoNegotiationError} when there is no common algorithm/version
 *
 * @example
 * ```js
 * const r = negotiateCrypto({ algorithms: ["x25519"] }, { algorithms: ["x25519"] });
 * r.algorithm;     // "x25519"
 * r.cryptoVersion; // "1.0"
 * ```
 */
export function negotiateCrypto(initiator, responder, options = {}) {
  const localSupported = options.supportedAlgorithms ?? SUPPORTED_ALGORITHMS;
  const initAlgos = normalizeAlgos(initiator?.algorithms, localSupported);
  const respAlgos = new Set(normalizeAlgos(responder?.algorithms, localSupported));

  let algorithm = null;
  const rejected = [];
  for (const algo of initAlgos) {
    if (respAlgos.has(algo) && localSupported.includes(algo)) {
      if (!algorithm) algorithm = algo;
    } else {
      rejected.push(algo);
    }
  }
  if (!algorithm) {
    throw new CryptoNegotiationError("No mutually-supported key-agreement algorithm", {
      details: { initiator: [...initAlgos], responder: [...respAlgos] },
    });
  }

  const cryptoVersion = negotiateCryptoVersion(
    initiator?.cryptoVersion ?? CRYPTO_PROTOCOL_VERSION,
    responder?.cryptoVersion ?? CRYPTO_PROTOCOL_VERSION,
    options.supportedVersions ?? SUPPORTED_CRYPTO_VERSIONS,
  );

  return { algorithm, cryptoVersion, rejectedAlgorithms: rejected };
}

/** Non-throwing compatibility check. */
export function canNegotiateCrypto(initiator, responder, options = {}) {
  try {
    negotiateCrypto(initiator, responder, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Agree a crypto protocol version (both must support it and be ≥ minimum). Picks the
 * highest common version.
 * @throws {CryptoNegotiationError}
 */
export function negotiateCryptoVersion(a, b, supported = SUPPORTED_CRYPTO_VERSIONS) {
  const set = new Set(supported);
  if (!set.has(a) || !set.has(b)) {
    throw new CryptoNegotiationError(`Unsupported crypto version (${a} / ${b})`, {
      details: { a, b, supported: [...set] },
    });
  }
  if (compareVersion(a, MIN_CRYPTO_PROTOCOL_VERSION) < 0 || compareVersion(b, MIN_CRYPTO_PROTOCOL_VERSION) < 0) {
    throw new CryptoNegotiationError("Crypto version below minimum", { details: { a, b } });
  }
  return compareVersion(a, b) <= 0 ? a : b;
}

/** Whether an algorithm is supported by this build. */
export function isAlgorithmSupported(algorithm) {
  return SUPPORTED_ALGORITHMS.includes(algorithm);
}

/** A descriptor advertising this build's crypto capabilities. */
export function cryptoCapabilities() {
  return {
    algorithms: [...SUPPORTED_ALGORITHMS],
    cryptoVersion: CRYPTO_PROTOCOL_VERSION,
    minCryptoVersion: MIN_CRYPTO_PROTOCOL_VERSION,
    supportedVersions: [...SUPPORTED_CRYPTO_VERSIONS],
  };
}

function normalizeAlgos(algorithms, fallback) {
  const list = Array.isArray(algorithms) && algorithms.length > 0 ? algorithms : [...fallback];
  return list.map((a) => String(a).toLowerCase());
}

function compareVersion(a, b) {
  const [amaj, amin] = String(a).split(".").map(Number);
  const [bmaj, bmin] = String(b).split(".").map(Number);
  if (amaj !== bmaj) return amaj < bmaj ? -1 : 1;
  if (amin !== bmin) return amin < bmin ? -1 : 1;
  return 0;
}
