/**
 * @module pdp/planner
 *
 * The **Connection Plan** builder — assembles the PRIMARY OUTPUT of PDP. A connection plan is a
 * transport-independent, validated snapshot that fuses everything the workflow resolved: the
 * selected device(s), a presence snapshot, the negotiated capabilities, the preferred + fallback
 * transports, protocol/crypto compatibility, and a priority. It is exactly what a FUTURE Layer 7
 * (NAT Traversal / ICE / WebRTC) needs to establish a connection.
 *
 * @important A connection plan describes WHO to connect to + HOW (which transport, which versions)
 * — it contains NO way to actually reach the peer (candidates, relays, ports). The `connection` and
 * `nat` blocks are inert placeholders Layer 7 fills. Building a plan opens nothing.
 *
 * @security A plan is PUBLIC — device ids, public identities, presence status, negotiated
 * versions/transports/flags. Never a private key, session key, or shared secret.
 */

import crypto from "node:crypto";
import {
  PDP_SCHEMA_VERSION,
  PDP_PROTOCOL_VERSION,
  DEFAULT_PLAN_TTL_MS,
} from "../types/types.js";

/**
 * FUTURE placeholder — connection-metadata block (Layer 7 · connection establishment). Inert in
 * Sprint 4; PDP never advertises HOW to reach a device.
 * @returns {object}
 */
export function createConnectionPlaceholder() {
  return {
    enabled: false,
    endpoints: null, // future: signaling endpoints
    channels: null, // future: negotiated channels
    reserved: true,
  };
}

/**
 * FUTURE placeholder — NAT-traversal metadata block (Layer 7 · NAT / ICE / STUN / TURN / WebRTC).
 * Inert in Sprint 4.
 * @returns {object}
 */
export function createNatPlaceholder() {
  return {
    enabled: false,
    candidates: null, // future: ICE candidates
    relays: null, // future: TURN relays
    reachability: null, // future
    reserved: true,
  };
}

/**
 * Derive a connection priority for the plan from the primary device (higher = more preferred).
 * Deterministic: score-driven, clamped to a small integer band.
 */
function derivePriority(primary) {
  const base = Math.round((primary?.score ?? 0) * 100);
  return Math.max(0, base);
}

/**
 * Assemble a {@link ConnectionPlan} from the workflow's resolved inputs.
 *
 * @param {object} params
 * @param {string} params.discoveryId the producing PDP session id
 * @param {string} params.requester @param {string} params.requesterDevice @param {string} params.targetUser
 * @param {import("../types/types.js").SelectedDevice[]} params.selectedDevices ranked; index 0 = primary
 * @param {Array<{deviceId:string,status:string,lastSeen:string|null}>} params.presenceSnapshot
 * @param {string} params.selectionPolicy
 * @param {number} [params.ttlMs] @param {object} [params.metadata]
 * @param {string} [params.planId] @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").ConnectionPlan}
 */
export function createConnectionPlan(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_PLAN_TTL_MS;

  const selectedDevices = params.selectedDevices ?? [];
  const primary = selectedDevices[0] ?? null;
  const negotiated = primary?.capabilities ?? null;

  return {
    planId: params.planId ?? idGenerator(),
    discoveryId: params.discoveryId,
    protocol: PDP_PROTOCOL_VERSION,
    requester: String(params.requester),
    requesterDevice: String(params.requesterDevice),
    targetUser: String(params.targetUser),
    selectedDevices,
    primaryDeviceId: primary?.deviceId ?? null,
    presenceSnapshot: params.presenceSnapshot ?? [],
    negotiatedCapabilities: negotiated,
    preferredTransport: negotiated?.preferredTransport ?? null,
    fallbackTransports: negotiated?.fallbackChain ?? [],
    protocolVersion: negotiated?.protocolVersion ?? null,
    cryptoVersion: negotiated?.cryptoVersion ?? null,
    cryptoCompatible: !!negotiated?.cryptoVersion,
    priority: derivePriority(primary),
    selectionPolicy: params.selectionPolicy,
    connection: createConnectionPlaceholder(), // FUTURE — inert
    nat: createNatPlaceholder(), // FUTURE — inert
    createdAt: nowIso,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    metadata: params.metadata ?? {},
    schemaVersion: PDP_SCHEMA_VERSION,
  };
}

/**
 * Whether a connection plan has passed its expiration instant.
 * @param {import("../types/types.js").ConnectionPlan} plan @param {number} [now] epoch ms
 * @returns {boolean}
 */
export function isPlanExpired(plan, now = Date.now()) {
  if (!plan?.expiresAt) return false;
  return new Date(plan.expiresAt).getTime() <= now;
}

/**
 * A stable cache key for a connection plan: same requester+device, target, policy, and requested
 * device subset → same key.
 * @param {{ requester: string, requesterDevice: string, targetUser: string, selectionPolicy: string, targetDevices?: string[] }} params
 * @returns {string}
 */
export function planCacheKey(params) {
  const devices = [...(params.targetDevices ?? [])].map(String).sort().join(",");
  return `${params.requester}:${params.requesterDevice}|${params.targetUser}|${params.selectionPolicy}|${devices}`;
}
