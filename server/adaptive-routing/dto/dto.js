/**
 * @module adaptive-routing/dto
 *
 * DTO normalization for the **Intelligent Routing** subsystem. Normalizes the two loose caller inputs the
 * adaptive layer accepts — a communication request (delegated to the frozen Sprint-1 normalizer) and the
 * optional per-request adaptive HINTS (declared capabilities, network availability, policy overrides,
 * scoring-weight overrides) — into stable, control-plane-only shapes. Deep validation is the validators'
 * job; content is never accepted.
 *
 * @security Capability/network hints are declarations (versions, transport ids, feature flags, availability
 * booleans) — no bytes. `payloadRef` stays the frozen Sprint-1 opaque descriptor.
 */

import { normalizeCommunicationRequest } from "../../communication-fabric/index.js";
import { Availability } from "../types/types.js";

const asString = (v) => (v == null ? undefined : String(v));
const asStringArray = (v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/** Normalize a raw capability declaration into the shape the {@link CapabilityEngine} consumes. */
export function normalizeCapabilityDeclaration(decl) {
  if (decl == null || typeof decl !== "object") return null;
  return {
    identityId: asString(decl.identityId),
    deviceId: asString(decl.deviceId) ?? null,
    appVersion: Number.isFinite(decl.appVersion) ? decl.appVersion : Number(decl.appVersion) || 1,
    protocolVersion: Number.isFinite(decl.protocolVersion) ? decl.protocolVersion : Number(decl.protocolVersion) || 1,
    transports: asStringArray(decl.transports),
    media: asStringArray(decl.media),
    features: asStringArray(decl.features),
    codecs: asStringArray(decl.codecs),
    flags: decl.flags && typeof decl.flags === "object" ? { ...decl.flags } : {},
  };
}

/** Normalize a network-availability hint into `{ substrate: Availability }` form. */
export function normalizeNetworkHint(hint) {
  if (hint == null || typeof hint !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(hint)) {
    if (typeof v === "boolean") out[k] = v ? Availability.AVAILABLE : Availability.UNAVAILABLE;
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Normalize the full adaptive evaluation input: the Sprint-1 communication request + adaptive hints.
 * @param {object} input `{ ...communicationRequest, capabilities?, receiverCapabilities?, network?, policyOverrides?, weights? }`
 * @returns {object}
 */
export function normalizeEvaluationInput(input = {}) {
  const request = normalizeCommunicationRequest(input);
  return {
    request,
    senderCapabilities: normalizeCapabilityDeclaration(input.capabilities ?? input.senderCapabilities),
    receiverCapabilities: Array.isArray(input.receiverCapabilities) ? input.receiverCapabilities.map(normalizeCapabilityDeclaration).filter(Boolean) : [],
    network: normalizeNetworkHint(input.network),
    policyOverrides: input.policyOverrides && typeof input.policyOverrides === "object" ? { ...input.policyOverrides } : {},
    weights: input.weights && typeof input.weights === "object" ? { ...input.weights } : null,
  };
}

/** Normalize pagination for list endpoints. */
export function normalizePagination({ limit, offset } = {}) {
  const lim = limit == null ? undefined : Math.max(1, Math.min(1000, Number(limit) || 0));
  const off = offset == null ? 0 : Math.max(0, Number(offset) || 0);
  return { limit: lim, offset: off };
}
