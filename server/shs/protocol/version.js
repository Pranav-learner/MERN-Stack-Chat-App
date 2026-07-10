/**
 * @module shs/protocol/version
 *
 * Protocol version management for the Secure Handshake System. Defines the current
 * and minimum supported versions, the compatibility rule, per-version feature
 * flags, and version negotiation between two parties.
 *
 * Versions are dotted `MAJOR.MINOR` strings. The compatibility rule is
 * **major-must-match, minor is backward-compatible**: two peers are compatible iff
 * they share a major version, and the negotiated version is the lower of the two
 * minors (so a newer peer can talk down to an older one).
 *
 * @example
 * ```js
 * import { negotiateVersion, CURRENT_VERSION } from "./protocol/version.js";
 * const v = negotiateVersion("1.2", "1.0"); // -> "1.0"
 * ```
 */

import { ProtocolVersionError } from "../errors.js";

/** The version this build speaks by default. */
export const CURRENT_VERSION = "1.0";

/** The oldest version this build will still negotiate with. */
export const MINIMUM_VERSION = "1.0";

/** All versions this build understands, newest last. */
export const SUPPORTED_VERSIONS = Object.freeze(["1.0"]);

/**
 * Feature capabilities available per protocol version. Sprint 1 defines the
 * framework capabilities only; cryptographic capabilities (`ecdh`, `ratchet`,
 * `pfs`, …) are intentionally absent and will be added by future sprints WITHOUT
 * changing this module's shape.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const VERSION_FEATURES = Object.freeze({
  "1.0": Object.freeze([
    "handshake.lifecycle", // create/accept/reject/cancel/complete
    "handshake.resume", // resume a non-terminal session
    "handshake.retry", // restart with backoff
    "handshake.capability-negotiation",
    "handshake.json", // JSON serialization
    "handshake.binary", // binary/compact serialization
  ]),
});

/** Parse a `MAJOR.MINOR` version string into numbers. @throws {ProtocolVersionError} */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)$/.exec(String(version ?? ""));
  if (!match) {
    throw new ProtocolVersionError(`Malformed protocol version: "${version}"`, { details: { version } });
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Whether a version string is one this build supports outright. */
export function isSupported(version) {
  return SUPPORTED_VERSIONS.includes(String(version));
}

/**
 * Whether two versions can interoperate (share a major version, both ≥ minimum).
 * @param {string} a @param {string} b @returns {boolean}
 */
export function isCompatible(a, b) {
  try {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    if (va.major !== vb.major) return false;
    // Both must be at or above the minimum supported version.
    if (compare(a, MINIMUM_VERSION) < 0 || compare(b, MINIMUM_VERSION) < 0) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare two versions. @returns {-1|0|1} sign of (a - b).
 */
export function compare(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  return 0;
}

/**
 * Negotiate the effective version between a local and a remote version. Returns
 * the lower minor within a shared major.
 * @param {string} local @param {string} remote
 * @returns {string} the agreed version
 * @throws {ProtocolVersionError} if the two are incompatible
 */
export function negotiateVersion(local, remote) {
  if (!isCompatible(local, remote)) {
    throw new ProtocolVersionError(`No compatible protocol version between "${local}" and "${remote}"`, {
      details: { local, remote, minimum: MINIMUM_VERSION },
    });
  }
  return compare(local, remote) <= 0 ? String(local) : String(remote);
}

/** The set of features offered by a given version (empty for unknown versions). */
export function featuresForVersion(version) {
  return [...(VERSION_FEATURES[String(version)] ?? [])];
}

/**
 * A version descriptor for advertising this build's capabilities in a message.
 * @returns {{ current: string, minimum: string, supported: string[], features: string[] }}
 */
export function versionDescriptor() {
  return {
    current: CURRENT_VERSION,
    minimum: MINIMUM_VERSION,
    supported: [...SUPPORTED_VERSIONS],
    features: featuresForVersion(CURRENT_VERSION),
  };
}
