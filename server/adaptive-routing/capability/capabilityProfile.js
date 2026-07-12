/**
 * @module adaptive-routing/capability/capabilityProfile
 *
 * The **Capability Profile** value object + negotiation (STEP 3). A profile is an IMMUTABLE snapshot of
 * what one party (sender / receiver / device) can do: its app + protocol versions, supported transports,
 * supported media, advertised feature flags, and future codecs. `negotiateProfiles` folds a sender + its
 * receivers into a single NEGOTIATED profile (the capability intersection) — the common ground the
 * Decision Engine + route scorer reason over. The Decision Engine consumes profiles, never a live service.
 *
 * @security A profile is pure control-plane metadata (versions + declared feature strings). No content.
 */

import crypto from "node:crypto";
import { TransportCapability, CapabilityFeature, MediaType, CURRENT_PROTOCOL_VERSION } from "../types/types.js";
import { deepFreeze } from "../_fabric.js";

/** A permissive baseline profile used when a party declares nothing (the Fabric stays functional). */
export const BASELINE_CAPABILITIES = Object.freeze({
  appVersion: 1,
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  transports: Object.freeze(Object.values(TransportCapability)),
  media: Object.freeze(Object.values(MediaType).filter((m) => m !== MediaType.NONE)),
  features: Object.freeze([CapabilityFeature.E2E_ENCRYPTION, CapabilityFeature.FORWARD_SECRECY, CapabilityFeature.OFFLINE_QUEUE, CapabilityFeature.MULTI_DEVICE_SYNC, CapabilityFeature.RECEIPTS, CapabilityFeature.GROUP_FANOUT]),
  codecs: Object.freeze([]),
});

/** Compute a stable fingerprint over the capability-defining fields (order-independent). */
export function capabilityFingerprint(profile) {
  const canonical = JSON.stringify({
    a: profile.appVersion,
    p: profile.protocolVersion,
    t: [...(profile.transports ?? [])].sort(),
    m: [...(profile.media ?? [])].sort(),
    f: [...(profile.features ?? [])].sort(),
    c: [...(profile.codecs ?? [])].sort(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Build an immutable capability profile from a (possibly partial) declaration, filling gaps from the
 * baseline.
 * @param {object} decl @param {object} [opts] @param {string} [opts.at] iso timestamp
 * @returns {import("../types/types.js").CapabilityProfile}
 */
export function createCapabilityProfile(decl = {}, opts = {}) {
  const merged = {
    identityId: decl.identityId ?? null,
    deviceId: decl.deviceId ?? null,
    appVersion: decl.appVersion ?? BASELINE_CAPABILITIES.appVersion,
    protocolVersion: decl.protocolVersion ?? BASELINE_CAPABILITIES.protocolVersion,
    transports: dedupe(decl.transports?.length ? decl.transports : BASELINE_CAPABILITIES.transports),
    media: dedupe(decl.media?.length ? decl.media : BASELINE_CAPABILITIES.media),
    features: dedupe(decl.features?.length ? decl.features : BASELINE_CAPABILITIES.features),
    codecs: dedupe(decl.codecs ?? BASELINE_CAPABILITIES.codecs),
    flags: decl.flags ?? {},
  };
  merged.fingerprint = capabilityFingerprint(merged);
  merged.collectedAt = opts.at ?? new Date().toISOString();
  return deepFreeze(merged);
}

/**
 * Negotiate a single profile from a sender + receivers: the INTERSECTION of transports/media/features and
 * the MINIMUM app/protocol version (the weakest party bounds the negotiation). With no receivers, the
 * sender profile is the negotiation.
 * @param {object} sender @param {object[]} receivers
 * @param {object} [opts]
 * @returns {import("../types/types.js").CapabilityProfile} the negotiated profile
 */
export function negotiateProfiles(sender, receivers = [], opts = {}) {
  const parties = [sender, ...receivers].filter(Boolean);
  if (parties.length === 0) return createCapabilityProfile({}, opts);
  if (parties.length === 1) return createCapabilityProfile({ ...parties[0], identityId: parties[0].identityId ?? null }, opts);

  const negotiated = {
    identityId: sender.identityId ?? null,
    deviceId: null,
    appVersion: Math.min(...parties.map((p) => p.appVersion ?? 1)),
    protocolVersion: Math.min(...parties.map((p) => p.protocolVersion ?? 1)),
    transports: intersectAll(parties.map((p) => p.transports ?? [])),
    media: intersectAll(parties.map((p) => p.media ?? [])),
    features: intersectAll(parties.map((p) => p.features ?? [])),
    codecs: intersectAll(parties.map((p) => p.codecs ?? [])),
    flags: {},
  };
  negotiated.fingerprint = capabilityFingerprint(negotiated);
  negotiated.collectedAt = opts.at ?? new Date().toISOString();
  return deepFreeze(negotiated);
}

/** Does the negotiated profile support a given transport capability / route kind? */
export function supportsTransport(profile, transport) {
  return (profile.transports ?? []).includes(transport);
}

/** Does the negotiated profile advertise a feature? */
export function hasFeature(profile, feature) {
  return (profile.features ?? []).includes(feature);
}

/** Does the negotiated profile support a media type? */
export function supportsMedia(profile, mediaType) {
  return (profile.media ?? []).includes(mediaType);
}

function dedupe(list) {
  return [...new Set(list ?? [])];
}

function intersectAll(lists) {
  if (lists.length === 0) return [];
  return lists.reduce((acc, list) => acc.filter((x) => list.includes(x)), [...new Set(lists[0])]);
}
