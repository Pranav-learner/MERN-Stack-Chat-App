/**
 * @module endpoint-selection/failover
 *
 * **Failover planning** — pure transforms that prepare a connection plan to survive a primary
 * endpoint failure. When the primary can't be used, promote the next-best fallback; when fresh
 * candidate data arrives, refresh the routing. No network reconnection happens here — this only
 * reshapes the PLAN so Layer 7 knows what to try next.
 *
 * @networking Robust connectivity is about having a *ready* next move. Failover pre-computes the
 * ordered alternatives so Layer 7 never has to re-run selection mid-attempt; it just walks the
 * plan's `priorityOrder` / `retryStrategy.order`.
 */

import { PlanStatus, DEFAULT_MAX_FALLBACKS } from "../types/types.js";
import { NoFallbackError } from "../errors.js";
import { buildRoutingDecision } from "../routing/routing.js";

/**
 * Promote the next fallback to primary (a failover). Returns a NEW plan object; does not mutate the
 * input. @throws {NoFallbackError} when there is no fallback to promote.
 *
 * @param {import("../types/types.js").EndpointConnectionPlan} plan
 * @param {{ reason?: string, now?: number }} [options]
 * @returns {{ plan: object, failedDevice: string|null, promotedDevice: string }}
 */
export function applyFailover(plan, options = {}) {
  const fallbacks = plan?.fallbackEndpoints ?? [];
  if (fallbacks.length === 0) {
    throw new NoFallbackError("No fallback endpoint available to fail over to", {
      details: { planId: plan?.planId, primaryDeviceId: plan?.primaryEndpoint?.deviceId ?? null },
    });
  }
  const nowIso = new Date(options.now ?? Date.now()).toISOString();
  const failedDevice = plan.primaryEndpoint?.deviceId ?? null;
  const [promoted, ...rest] = fallbacks;
  const priorityOrder = [promoted, ...rest].map((e) => e.deviceId);

  const newPlan = {
    ...plan,
    status: PlanStatus.FAILED_OVER,
    primaryEndpoint: promoted,
    fallbackEndpoints: rest,
    priorityOrder,
    negotiatedCapabilities: promoted.capabilities ?? null,
    preferredTransport: promoted.capabilities?.preferredTransport ?? null,
    fallbackTransports: promoted.capabilities?.fallbackChain ?? [],
    retryStrategy: { ...plan.retryStrategy, order: priorityOrder },
    selectionReason: `failover from ${failedDevice ?? "?"} → ${promoted.deviceId}${options.reason ? ` (${options.reason})` : ""}`,
    priority: promoted.priority ?? 0,
    generation: (plan.generation ?? 0) + 1,
    updatedAt: nowIso,
    metadata: { ...(plan.metadata ?? {}), failedOverFrom: [...(plan.metadata?.failedOverFrom ?? []), failedDevice].filter(Boolean) },
  };
  return { plan: newPlan, failedDevice, promotedDevice: promoted.deviceId };
}

/**
 * Mark a plan EXHAUSTED (primary + all fallbacks failed). Returns a NEW plan object.
 * @param {object} plan @param {{ now?: number }} [options] @returns {object}
 */
export function markExhausted(plan, options = {}) {
  return { ...plan, status: PlanStatus.EXHAUSTED, updatedAt: new Date(options.now ?? Date.now()).toISOString() };
}

/**
 * Refresh a plan's routing from freshly ranked endpoints (e.g. after presence/capability change or
 * a recovered device). Keeps the same planId, bumps the generation, and resets status to ACTIVE.
 * Returns a NEW plan object.
 *
 * @param {object} plan @param {import("../types/types.js").ScoredEndpoint[]} ranked fresh best-first
 * @param {{ maxFallbacks?: number, now?: number }} [options]
 * @returns {object}
 */
export function refreshRouting(plan, ranked, options = {}) {
  const routing = buildRoutingDecision(ranked, { maxFallbacks: options.maxFallbacks ?? DEFAULT_MAX_FALLBACKS, retry: plan.retryStrategy });
  const nowIso = new Date(options.now ?? Date.now()).toISOString();
  const negotiated = routing.primary?.capabilities ?? null;
  return {
    ...plan,
    status: PlanStatus.ACTIVE,
    primaryEndpoint: routing.primary,
    fallbackEndpoints: routing.fallbacks,
    priorityOrder: routing.priorityOrder,
    negotiatedCapabilities: negotiated,
    preferredTransport: negotiated?.preferredTransport ?? null,
    fallbackTransports: negotiated?.fallbackChain ?? [],
    retryStrategy: routing.retryStrategy,
    priority: routing.primary?.priority ?? 0,
    generation: (plan.generation ?? 0) + 1,
    updatedAt: nowIso,
  };
}
