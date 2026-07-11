/**
 * @module capabilities/negotiation
 *
 * The **Negotiation Engine** — the deterministic core of Sprint 3. Given two capability sets it
 * computes *how the two devices can communicate*: the highest common protocol + crypto version,
 * shared compression, negotiated attachment limits, the intersection of enabled feature flags, the
 * transports they share, and — via a {@link module:capabilities/policies transport policy} — the
 * PREFERRED transport plus an ordered fallback chain.
 *
 * @important This produces a {@link NegotiationResult} — a compatibility + preference plan. It
 * does NOT open a connection, perform NAT traversal, or do any ICE/STUN/TURN/WebRTC work. A later
 * layer consumes the result to actually connect.
 *
 * @networking The function is **pure + deterministic + symmetric** where it must be: negotiating
 * (A, B) and (B, A) yields the same protocol/crypto/compression/features/shared-transports and the
 * same preferred transport (given the same policy). This is what lets two peers independently
 * agree without a round-trip.
 */

import {
  CompressionType,
  CapabilityFailureReason,
  CAPABILITY_SCHEMA_VERSION,
} from "../types/types.js";
import { highestCommonVersion } from "../version/version.js";
import { selectPreferredTransport, resolvePolicy } from "../policies/transportPolicy.js";
import { toNegotiable } from "../record/capabilityRecord.js";

/** Compression preference order used to pick the "best" shared algorithm (most → least capable). */
const COMPRESSION_PREFERENCE = [CompressionType.BROTLI, CompressionType.GZIP, CompressionType.DEFLATE, CompressionType.NONE];

/**
 * Intersect two arrays preserving the order of the FIRST (sorted for determinism where noted).
 */
function intersect(a, b) {
  const setB = new Set(b ?? []);
  return (a ?? []).filter((x) => setB.has(x));
}

/** The intersection of feature flags BOTH sides enable (a flag is on only if both set it true). */
function negotiateFeatureFlags(a, b) {
  const out = {};
  for (const [flag, enabled] of Object.entries(a ?? {})) {
    if (enabled === true && b?.[flag] === true) out[flag] = true;
  }
  return out;
}

/** Pick the most-preferred compression both sides support (falls back to "none"). */
function negotiateCompression(a, b) {
  const shared = new Set(intersect(a ?? [CompressionType.NONE], b ?? [CompressionType.NONE]));
  for (const c of COMPRESSION_PREFERENCE) if (shared.has(c)) return c;
  return CompressionType.NONE;
}

/**
 * Negotiate two capability sets into a deterministic {@link NegotiationResult}.
 *
 * @param {object} localCaps a capability set or record (the caller's device)
 * @param {object} remoteCaps a capability set or record (the peer's device)
 * @param {{ policy?: string|object }} [options] transport-preference policy (default AUTO)
 * @returns {import("../types/types.js").NegotiationResult}
 */
export function negotiateCapabilities(localCaps, remoteCaps, options = {}) {
  const a = toNegotiable(localCaps ?? {});
  const b = toNegotiable(remoteCaps ?? {});
  const policy = resolvePolicy(options.policy);

  const protocolVersion = highestCommonVersion(a.protocolVersions, b.protocolVersions);
  const cryptoVersion = highestCommonVersion(a.cryptoVersions, b.cryptoVersions);
  // Deterministic shared-transport set: sort so (A,B) and (B,A) agree before the policy orders it.
  const sharedTransports = intersect(a.transports, b.transports).sort();
  const { preferredTransport, fallbackChain, policy: policyName } = selectPreferredTransport(sharedTransports, policy);

  const base = {
    compression: negotiateCompression(a.compression, b.compression),
    maxPayloadSize: Math.min(a.maxPayloadSize || 0, b.maxPayloadSize || 0) || 0,
    attachments: {
      supported: !!(a.attachments?.supported && b.attachments?.supported),
      maxSize: Math.min(a.attachments?.maxSize || 0, b.attachments?.maxSize || 0) || 0,
    },
    sharedTransports,
    preferredTransport,
    fallbackChain,
    featureFlags: negotiateFeatureFlags(a.featureFlags, b.featureFlags),
    relay: !!(a.relaySupport && b.relaySupport),
    policy: policyName,
    transport: { enabled: false, candidates: null, relays: null, reserved: true }, // FUTURE — inert
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
  };

  // Compatibility gates, most-fundamental first.
  const failureReason = firstFailure({ protocolVersion, cryptoVersion, sharedTransports });
  if (failureReason) {
    return { compatible: false, protocolVersion, cryptoVersion, ...base, failureReason };
  }
  return { compatible: true, protocolVersion, cryptoVersion, ...base, failureReason: null };
}

/** Determine the first (most fundamental) compatibility failure, or null when compatible. */
function firstFailure({ protocolVersion, cryptoVersion, sharedTransports }) {
  if (!protocolVersion) return CapabilityFailureReason.INCOMPATIBLE_PROTOCOL_VERSION;
  if (!cryptoVersion) return CapabilityFailureReason.INCOMPATIBLE_CRYPTO_VERSION;
  if (!sharedTransports || sharedTransports.length === 0) return CapabilityFailureReason.NO_SHARED_TRANSPORT;
  return null;
}

/**
 * A stable cache/dedupe key for a negotiation, VERSION-AWARE so a capability update (which bumps a
 * device's version) naturally invalidates any cached result. Order-independent in the device pair.
 * @param {object} localCaps @param {object} remoteCaps @param {string} [policyName]
 * @returns {string}
 */
export function negotiationKey(localCaps, remoteCaps, policyName = "auto") {
  const a = toNegotiable(localCaps ?? {});
  const b = toNegotiable(remoteCaps ?? {});
  const left = `${a.userId}:${a.deviceId}@${a.version}`;
  const right = `${b.userId}:${b.deviceId}@${b.version}`;
  const [x, y] = [left, right].sort();
  return `${x}|${y}|${policyName}`;
}
