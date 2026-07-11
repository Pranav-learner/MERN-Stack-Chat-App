/**
 * @module endpoint-selection/routing
 *
 * **Routing decisions** — turns a ranked list of scored endpoints into the concrete routing shape a
 * connection plan carries: a primary endpoint, an ordered list of fallback endpoints, a priority
 * order, and a retry strategy. Pure logic — no I/O, no connection.
 *
 * @networking A routing decision is the "how to try" half of a plan: which endpoint first, which
 * next, how many attempts each, and the backoff between them. Layer 7 executes this ordering; this
 * module only prepares it.
 */

import {
  DEFAULT_MAX_FALLBACKS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
} from "../types/types.js";
import { inferDeviceType } from "../scorer/scoring.js";

/** Shape a scored endpoint into the PUBLIC endpoint descriptor a plan stores. */
export function toEndpoint(scored) {
  if (!scored) return null;
  const c = scored.candidate ?? {};
  return {
    deviceId: scored.deviceId,
    identityId: c.identityId ?? null,
    publicIdentity: c.publicIdentity ?? null,
    presenceStatus: c.presenceStatus,
    lastSeen: c.lastSeen ?? null,
    platform: c.platform,
    deviceType: inferDeviceType(c),
    softwareVersion: c.softwareVersion,
    capabilities: c.capabilities ?? null,
    preferredTransport: c.capabilities?.preferredTransport ?? null,
    score: scored.score,
    breakdown: { ...(scored.breakdown ?? {}) },
    rank: scored.rank,
    priority: Math.max(0, Math.round((scored.score ?? 0) * 100) - (scored.rank ?? 0)),
    eligible: scored.eligible,
  };
}

/**
 * Build a routing decision from ranked scored endpoints.
 *
 * @param {import("../types/types.js").ScoredEndpoint[]} ranked best-first
 * @param {object} [options]
 * @param {number} [options.maxFallbacks] cap on fallback endpoints
 * @param {{ maxAttempts?: number, backoffMs?: number }} [options.retry]
 * @returns {{ primary: object|null, fallbacks: object[], priorityOrder: string[], retryStrategy: object }}
 */
export function buildRoutingDecision(ranked, options = {}) {
  const eligible = (ranked ?? []).filter((r) => r.eligible);
  const maxFallbacks = options.maxFallbacks ?? DEFAULT_MAX_FALLBACKS;

  const primary = eligible.length > 0 ? toEndpoint(eligible[0]) : null;
  const fallbacks = eligible.slice(1, 1 + maxFallbacks).map(toEndpoint);
  const priorityOrder = [primary, ...fallbacks].filter(Boolean).map((e) => e.deviceId);

  const retryStrategy = {
    maxAttempts: options.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    backoffMs: options.retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
    order: priorityOrder,
  };

  return { primary, fallbacks, priorityOrder, retryStrategy };
}

/**
 * Produce a human-readable reason for why a primary was chosen — its top-weighted contributing
 * dimensions. Deterministic. @param {object} endpoint a plan endpoint (with `breakdown`)
 * @param {string} policyName @returns {string}
 */
export function describeSelection(endpoint, policyName) {
  if (!endpoint) return "no eligible endpoint";
  const top = Object.entries(endpoint.breakdown ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([dim, v]) => `${dim}=${v.toFixed(2)}`);
  return `${policyName}: score ${endpoint.score.toFixed(3)} (${top.join(", ")})`;
}

/**
 * Re-order a routing decision so a specific device is tried first (alternative routing) — used when
 * a caller wants to reroute without recomputing scores. Preserves the rest of the order.
 * @param {object} routing a routing decision @param {string} deviceId @returns {object} new routing decision
 */
export function rerouteFirst(routing, deviceId) {
  const all = [routing.primary, ...(routing.fallbacks ?? [])].filter(Boolean);
  const idx = all.findIndex((e) => e.deviceId === deviceId);
  if (idx <= 0) return routing; // already primary or not present
  const chosen = all[idx];
  const rest = all.filter((_, i) => i !== idx);
  const ordered = [chosen, ...rest];
  const priorityOrder = ordered.map((e) => e.deviceId);
  return {
    primary: chosen,
    fallbacks: ordered.slice(1),
    priorityOrder,
    retryStrategy: { ...routing.retryStrategy, order: priorityOrder },
  };
}
