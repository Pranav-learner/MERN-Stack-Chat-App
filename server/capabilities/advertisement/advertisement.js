/**
 * @module capabilities/advertisement
 *
 * **Capability Advertisement** builders. A device advertises the negotiable fields that describe
 * *how it can communicate* — supported protocol/crypto versions, transports, compression,
 * attachment limits, feature flags, and platform features. This module normalizes raw input into
 * a canonical, extensible capability payload and provides the inert `p2p` placeholder that a
 * FUTURE NAT/WebRTC sprint fills in.
 *
 * @security A capability advertisement is PUBLIC — versions, transport names, limits, feature
 * flags. It carries NO key material. The no-secret invariant is enforced by
 * {@link module:capabilities/validators.assertNoSecretMaterial} before storage.
 *
 * @evolution Capabilities are EXTENSIBLE: unknown `featureFlags` and free-form `metadata` are
 * carried through negotiation unchanged, so new features can be added without a schema change. The
 * `p2p` block is the reserved extension point for peer-to-peer support a later layer implements.
 */

import {
  TransportType,
  CompressionType,
  SUPPORTED_PROTOCOL_VERSIONS,
  SUPPORTED_CRYPTO_VERSIONS,
  DEFAULT_MAX_PAYLOAD_SIZE,
} from "../types/types.js";
import { normalizeVersions } from "../version/version.js";

/**
 * FUTURE placeholder — peer-to-peer support block (Layer 6/7 · NAT Traversal / WebRTC sprints).
 * Inert in Sprint 3; declaring P2P support here does NOT enable a P2P connection.
 * @returns {object}
 */
export function createP2PPlaceholder() {
  return {
    enabled: false,
    natTraversal: null, // future: supported NAT-traversal methods (ICE/STUN/TURN)
    directConnection: null, // future
    reserved: true,
  };
}

/** Keep only known transport strings, de-duplicated, preserving the device's own order. */
function normalizeTransports(transports) {
  const known = new Set(Object.values(TransportType));
  const seen = new Set();
  const out = [];
  for (const t of transports ?? []) {
    const s = String(t);
    if (known.has(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.length > 0 ? out : [TransportType.WEBSOCKET];
}

/** Keep only known compression strings, de-duplicated; always include NONE as a floor. */
function normalizeCompression(compression) {
  const known = new Set(Object.values(CompressionType));
  const seen = new Set();
  const out = [];
  for (const c of compression ?? []) {
    const s = String(c);
    if (known.has(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  if (!seen.has(CompressionType.NONE)) out.push(CompressionType.NONE);
  return out;
}

/** Normalize feature flags into a plain `{ [name]: boolean }` map (drops non-boolean values). */
function normalizeFeatureFlags(flags) {
  const out = {};
  if (flags && typeof flags === "object" && !Array.isArray(flags)) {
    for (const [k, v] of Object.entries(flags)) {
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

/**
 * Build a normalized, PUBLIC capability advertisement payload from raw input. Applies build
 * defaults for anything omitted so a minimal registration still produces a complete, negotiable
 * capability set.
 *
 * @param {object} params
 * @param {string[]} [params.protocolVersions] @param {string[]} [params.cryptoVersions]
 * @param {string[]} [params.transports] @param {string[]} [params.compression]
 * @param {{ supported?: boolean, maxSize?: number, mimeTypes?: string[] }} [params.attachments]
 * @param {number} [params.maxPayloadSize]
 * @param {boolean} [params.relaySupport]
 * @param {string[]} [params.connectionPreferences] ordered transport preference (policy input)
 * @param {string[]} [params.platformFeatures]
 * @param {string} [params.softwareVersion]
 * @param {Record<string, boolean>} [params.featureFlags]
 * @param {object} [params.metadata]
 * @returns {object} the normalized capability payload
 */
export function createCapabilityAdvertisement(params = {}) {
  const transports = normalizeTransports(params.transports);
  const maxPayloadSize = Number.isFinite(params.maxPayloadSize) && params.maxPayloadSize > 0 ? params.maxPayloadSize : DEFAULT_MAX_PAYLOAD_SIZE;
  const attachments = {
    supported: params.attachments?.supported ?? true,
    maxSize: Number.isFinite(params.attachments?.maxSize) && params.attachments.maxSize > 0 ? params.attachments.maxSize : maxPayloadSize,
    ...(params.attachments?.mimeTypes ? { mimeTypes: [...params.attachments.mimeTypes] } : {}),
  };
  return {
    protocolVersions: normalizeVersions(params.protocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS),
    cryptoVersions: normalizeVersions(params.cryptoVersions ?? SUPPORTED_CRYPTO_VERSIONS),
    transports,
    compression: normalizeCompression(params.compression),
    attachments,
    maxPayloadSize,
    relaySupport: params.relaySupport ?? transports.includes(TransportType.RELAY),
    p2p: createP2PPlaceholder(),
    // The device's own preference order; defaults to its declared transport order.
    connectionPreferences: normalizeTransports(params.connectionPreferences ?? transports),
    platformFeatures: [...(params.platformFeatures ?? [])].map(String),
    softwareVersion: params.softwareVersion,
    featureFlags: normalizeFeatureFlags(params.featureFlags),
    metadata: params.metadata ?? {},
  };
}
