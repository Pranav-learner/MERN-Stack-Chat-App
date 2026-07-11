/**
 * @module capabilities/policies
 *
 * **Transport-preference policies.** Given the set of transports two devices BOTH support, a
 * policy decides which one they should PREFER and the ordered fallback chain behind it. A policy
 * is just a priority ordering over transport types plus a name.
 *
 * @important This module SELECTS a preference — it does NOT establish anything. Choosing
 * `"webrtc"` here means "if/when a later layer can open a WebRTC data channel, prefer it"; it does
 * not open one. Connection establishment (NAT traversal, ICE, the actual socket) belongs to later
 * layers that consume this selection.
 *
 * @networking Priority ordering + a fallback chain is the standard shape of transport selection
 * (mirrors how ICE orders candidate types). Both peers applying the SAME policy to the SAME shared
 * set arrive at the same preferred transport — deterministic by construction.
 */

import { TransportType } from "../types/types.js";

/**
 * Built-in policies. Each is `{ name, priority }` where `priority` is a transport ordering from
 * most- to least-preferred. Transports not listed rank last (in their declared order).
 */
export const TransportPolicy = Object.freeze({
  /** Automatic: prefer the most capable transport available, degrade gracefully to the relay. */
  AUTO: Object.freeze({
    name: "auto",
    priority: [TransportType.WEBRTC, TransportType.QUIC, TransportType.RELAY, TransportType.WEBSOCKET, TransportType.TCP],
  }),
  /** Prefer WebRTC (future direct data channel), else fall back down the chain. */
  PREFER_WEBRTC: Object.freeze({
    name: "prefer-webrtc",
    priority: [TransportType.WEBRTC, TransportType.QUIC, TransportType.RELAY, TransportType.WEBSOCKET, TransportType.TCP],
  }),
  /** Prefer QUIC. */
  PREFER_QUIC: Object.freeze({
    name: "prefer-quic",
    priority: [TransportType.QUIC, TransportType.WEBRTC, TransportType.RELAY, TransportType.WEBSOCKET, TransportType.TCP],
  }),
  /** Prefer the server relay (most reachable; works behind any NAT). */
  PREFER_RELAY: Object.freeze({
    name: "prefer-relay",
    priority: [TransportType.RELAY, TransportType.WEBSOCKET, TransportType.QUIC, TransportType.WEBRTC, TransportType.TCP],
  }),
  /** Prefer the existing WebSocket transport (available today). */
  PREFER_WEBSOCKET: Object.freeze({
    name: "prefer-websocket",
    priority: [TransportType.WEBSOCKET, TransportType.RELAY, TransportType.QUIC, TransportType.WEBRTC, TransportType.TCP],
  }),
});

/** All built-in policies by name. */
const POLICIES_BY_NAME = Object.freeze(
  Object.fromEntries(Object.values(TransportPolicy).map((p) => [p.name, p])),
);

/** The default policy when none is specified. */
export const DEFAULT_TRANSPORT_POLICY = TransportPolicy.AUTO;

/**
 * Resolve a policy from a name, a policy object, or nothing (→ default).
 * @param {string|{name:string,priority:string[]}} [policy]
 * @returns {{ name: string, priority: string[] }}
 */
export function resolvePolicy(policy) {
  if (!policy) return DEFAULT_TRANSPORT_POLICY;
  if (typeof policy === "string") return POLICIES_BY_NAME[policy] ?? DEFAULT_TRANSPORT_POLICY;
  if (Array.isArray(policy.priority)) return { name: policy.name ?? "custom", priority: policy.priority };
  return DEFAULT_TRANSPORT_POLICY;
}

/**
 * Order a set of shared transports by a policy's priority. Transports the policy doesn't rank are
 * appended in their input order (after the ranked ones).
 * @param {string[]} sharedTransports @param {string|object} [policy]
 * @returns {string[]} the shared transports, most- to least-preferred
 */
export function orderByPolicy(sharedTransports, policy) {
  const { priority } = resolvePolicy(policy);
  const shared = [...new Set(sharedTransports ?? [])];
  const ranked = priority.filter((t) => shared.includes(t));
  const unranked = shared.filter((t) => !priority.includes(t));
  return [...ranked, ...unranked];
}

/**
 * Select the preferred transport + fallback chain from a set of shared transports.
 * @param {string[]} sharedTransports @param {string|object} [policy]
 * @returns {{ preferredTransport: string|null, fallbackChain: string[], policy: string }}
 */
export function selectPreferredTransport(sharedTransports, policy) {
  const resolved = resolvePolicy(policy);
  const ordered = orderByPolicy(sharedTransports, resolved);
  return {
    preferredTransport: ordered[0] ?? null,
    fallbackChain: ordered.slice(1),
    policy: resolved.name,
  };
}
