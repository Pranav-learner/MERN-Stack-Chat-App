/**
 * @module endpoint-selection/planner
 *
 * The **Connection Plan** builder — assembles the OPTIMIZED, failover-ready
 * {@link EndpointConnectionPlan} from a routing decision. This extends the PDP connection-plan idea
 * with a scored primary + ranked fallbacks, a selection reason, a retry strategy, and a per-
 * dimension score breakdown. It is the subsystem's primary output.
 *
 * @important A plan describes WHICH endpoint(s) to use + in what order + how to retry — it contains
 * NO way to actually reach a peer (candidates, relays, sockets). The `nat` block is an inert
 * placeholder Layer 7 fills. Building a plan opens nothing.
 *
 * @security A plan is PUBLIC — device ids, public identities, presence status, negotiated
 * versions/transports/flags, scores. Never a private key, session key, or shared secret.
 */

import crypto from "node:crypto";
import {
  PlanStatus,
  ES_SCHEMA_VERSION,
  ES_FRAMEWORK,
  DEFAULT_PLAN_TTL_MS,
} from "../types/types.js";
import { buildRoutingDecision, describeSelection } from "../routing/routing.js";

/**
 * FUTURE placeholder — NAT-traversal metadata block (Layer 7 · ICE / STUN / TURN / WebRTC). Inert
 * in Sprint 5. @returns {object}
 */
export function createNatPlaceholder() {
  return { enabled: false, candidates: null, relays: null, reachability: null, natType: null, reserved: true };
}

/**
 * Assemble an {@link EndpointConnectionPlan} from ranked scored endpoints.
 *
 * @param {object} params
 * @param {string} params.requester @param {string} params.requesterDevice @param {string} params.targetUser
 * @param {import("../types/types.js").ScoredEndpoint[]} params.ranked best-first scored endpoints
 * @param {string} params.policyName @param {Record<string, number>} params.weights the applied weights
 * @param {number} [params.maxFallbacks] @param {{ maxAttempts?: number, backoffMs?: number }} [params.retry]
 * @param {number} [params.ttlMs] @param {object} [params.metadata]
 * @param {string} [params.planId] @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").EndpointConnectionPlan}
 */
export function createEndpointConnectionPlan(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_PLAN_TTL_MS;

  const routing = buildRoutingDecision(params.ranked, { maxFallbacks: params.maxFallbacks, retry: params.retry });
  const primary = routing.primary;
  const negotiated = primary?.capabilities ?? null;

  return {
    planId: params.planId ?? idGenerator(),
    framework: ES_FRAMEWORK,
    requester: String(params.requester),
    requesterDevice: String(params.requesterDevice),
    targetUser: String(params.targetUser),
    status: PlanStatus.ACTIVE,
    primaryEndpoint: primary,
    fallbackEndpoints: routing.fallbacks,
    priorityOrder: routing.priorityOrder,
    selectionReason: describeSelection(primary, params.policyName),
    negotiatedCapabilities: negotiated,
    preferredTransport: negotiated?.preferredTransport ?? null,
    fallbackTransports: negotiated?.fallbackChain ?? [],
    retryStrategy: routing.retryStrategy,
    selectionPolicy: params.policyName,
    weights: { ...(params.weights ?? {}) },
    nat: createNatPlaceholder(), // FUTURE — inert
    priority: primary?.priority ?? 0,
    generation: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    metadata: params.metadata ?? {},
    schemaVersion: ES_SCHEMA_VERSION,
  };
}

/** Whether a connection plan has passed its expiration instant. @returns {boolean} */
export function isPlanExpired(plan, now = Date.now()) {
  if (!plan?.expiresAt) return false;
  return new Date(plan.expiresAt).getTime() <= now;
}

/**
 * A stable cache key for a plan/selection: same requester+device, target, policy, and candidate
 * device set → same key. Candidate-set-aware so a change in the reachable set re-keys.
 * @param {{ requester: string, requesterDevice: string, targetUser: string, policyName: string, candidateIds?: string[] }} params
 * @returns {string}
 */
export function planCacheKey(params) {
  const ids = [...(params.candidateIds ?? [])].map(String).sort().join(",");
  return `${params.requester}:${params.requesterDevice}|${params.targetUser}|${params.policyName}|${ids}`;
}
