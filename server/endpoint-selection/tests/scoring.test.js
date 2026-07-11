/**
 * Scoring engine, policies, ranking, planner, routing, and failover tests (Layer 6, Sprint 5).
 * Mostly pure + DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeIdGen, cap, candidate } from "./helpers.js";
import {
  scoreEndpoint,
  rankEndpoints,
  inferDeviceType,
  isReachable,
} from "../scorer/scoring.js";
import { POLICY_PROFILES, resolvePolicy, isKnownPolicy } from "../policies/policies.js";
import { buildRoutingDecision, toEndpoint, rerouteFirst, describeSelection } from "../routing/routing.js";
import { createEndpointConnectionPlan, isPlanExpired, planCacheKey } from "../planner/connectionPlan.js";
import { applyFailover, markExhausted, refreshRouting } from "../failover/failover.js";
import { SelectionPolicy, ScoringDimension, DeviceType, PlanStatus } from "../types/types.js";
import { NoFallbackError } from "../errors.js";

const W = POLICY_PROFILES[SelectionPolicy.HIGHEST_SCORE].weights;

// ---------------------------------------------------------------------------
describe("device type inference", () => {
  it("infers desktop/mobile/unknown from platform + explicit type", () => {
    assert.equal(inferDeviceType({ platform: "web (Chrome)" }), DeviceType.DESKTOP);
    assert.equal(inferDeviceType({ platform: "iOS 17" }), DeviceType.MOBILE);
    assert.equal(inferDeviceType({ platform: "android" }), DeviceType.MOBILE);
    assert.equal(inferDeviceType({ platform: "toaster" }), DeviceType.UNKNOWN);
    assert.equal(inferDeviceType({ deviceType: "desktop", platform: "ios" }), DeviceType.DESKTOP); // explicit wins
  });
});

// ---------------------------------------------------------------------------
describe("scoring engine", () => {
  const ctx = { now: 1_700_000_000_000 };

  it("scores a healthy candidate high + eligible; weighted average is [0,1]", () => {
    const { score, breakdown, eligible } = scoreEndpoint(candidate("d1"), ctx, W);
    assert.ok(score > 0.5 && score <= 1);
    assert.equal(eligible, true);
    assert.equal(breakdown[ScoringDimension.PRESENCE], 1); // online
    assert.ok(breakdown[ScoringDimension.CAPABILITY] > 0);
  });

  it("gates ineligible: unreachable → not eligible", () => {
    const r = scoreEndpoint(candidate("d1", { presenceStatus: "offline" }), ctx, W);
    assert.equal(r.eligible, false);
    assert.equal(r.ineligibleReason, "no-reachable-endpoint");
  });

  it("gates ineligible: incompatible capabilities → not eligible", () => {
    const r = scoreEndpoint(candidate("d1", { capabilities: { compatible: false } }), ctx, W);
    assert.equal(r.eligible, false);
    assert.equal(r.ineligibleReason, "capability-mismatch");
  });

  it("gates ineligible: fails a minimum crypto-version security requirement", () => {
    const secureCtx = { ...ctx, securityRequirements: { minCryptoVersion: "2.0" } };
    const r = scoreEndpoint(candidate("d1", { capabilities: cap({ cryptoVersion: "1.0" }) }), secureCtx, W);
    assert.equal(r.eligible, false);
    assert.equal(r.ineligibleReason, "capability-mismatch");
  });

  it("richer capabilities score higher than poorer ones", () => {
    const rich = scoreEndpoint(candidate("a", { capabilities: cap({ sharedTransports: ["webrtc", "quic", "relay", "websocket"], featureFlags: { a: true, b: true } }) }), ctx, W).score;
    const poor = scoreEndpoint(candidate("b", { capabilities: cap({ sharedTransports: ["relay"], preferredTransport: "relay", compression: "none", featureFlags: {} }) }), ctx, W).score;
    assert.ok(rich > poor);
  });

  it("reliability history raises the score; recency + priority contribute", () => {
    const withHistory = { ...ctx, reliability: { d1: { successes: 10, failures: 0 } } };
    const hi = scoreEndpoint(candidate("d1"), withHistory, { [ScoringDimension.RELIABILITY]: 1 }).breakdown.reliability;
    const neutral = scoreEndpoint(candidate("d1"), ctx, { [ScoringDimension.RELIABILITY]: 1 }).breakdown.reliability;
    assert.ok(hi > neutral);
  });

  it("custom extra dimensions plug in (extensible)", () => {
    const extra = { customBoost: () => 1 };
    const r = scoreEndpoint(candidate("d1"), ctx, { customBoost: 1 }, extra);
    assert.equal(r.breakdown.customBoost, 1);
    assert.equal(r.score, 1);
  });

  it("isReachable helper", () => {
    assert.ok(isReachable({ presenceStatus: "away" }));
    assert.ok(!isReachable({ presenceStatus: "reconnecting" }));
  });
});

// ---------------------------------------------------------------------------
describe("ranking", () => {
  it("ranks eligible above ineligible, higher score first, deterministic tie-break by deviceId", () => {
    const cands = [
      candidate("z", { capabilities: cap() }),
      candidate("a", { capabilities: cap() }), // identical to z → tie, a first
      candidate("off", { presenceStatus: "offline" }), // ineligible → last
    ];
    const ranked = rankEndpoints(cands, { now: 1_700_000_000_000 }, W);
    assert.equal(ranked[0].deviceId, "a"); // tie broken by id asc
    assert.equal(ranked[1].deviceId, "z");
    assert.equal(ranked[2].deviceId, "off");
    assert.equal(ranked[2].eligible, false);
    assert.deepEqual(ranked.map((r) => r.rank), [0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
describe("policies", () => {
  it("resolves named + custom + default policies", () => {
    assert.equal(resolvePolicy("battery-friendly").preferType, DeviceType.DESKTOP);
    assert.equal(resolvePolicy("mobile-preferred").preferType, DeviceType.MOBILE);
    assert.equal(resolvePolicy(undefined).name, SelectionPolicy.HIGHEST_SCORE);
    assert.equal(resolvePolicy("nonsense").name, SelectionPolicy.HIGHEST_SCORE);
    const custom = resolvePolicy({ name: "custom", weights: { presence: 1 } });
    assert.deepEqual(custom.weights, { presence: 1 });
    assert.ok(isKnownPolicy("highest-score"));
    assert.ok(!isKnownPolicy("nope"));
  });

  it("weight overrides merge onto a profile", () => {
    const p = resolvePolicy("highest-score", { weights: { presence: 99 } });
    assert.equal(p.weights.presence, 99);
    assert.ok(p.weights.capability > 0); // others preserved
  });
});

// ---------------------------------------------------------------------------
describe("routing + planner", () => {
  const ranked = (ids) => rankEndpoints(ids.map((id) => candidate(id)), { now: 1_700_000_000_000 }, W);

  it("builds a routing decision: primary + fallbacks + priority order + retry", () => {
    const r = buildRoutingDecision(ranked(["a", "b", "c", "d", "e"]), { maxFallbacks: 2 });
    assert.equal(r.priorityOrder.length, 3); // primary + 2 fallbacks
    assert.equal(r.retryStrategy.order[0], r.primary.deviceId);
    assert.equal(r.retryStrategy.maxAttempts, 3);
  });

  it("routing has no primary when nothing is eligible", () => {
    const r = buildRoutingDecision(rankEndpoints([candidate("x", { presenceStatus: "offline" })], { now: 1 }, W));
    assert.equal(r.primary, null);
    assert.equal(r.priorityOrder.length, 0);
  });

  it("assembles a connection plan; rerouteFirst reorders", () => {
    const plan = createEndpointConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", ranked: ranked(["a", "b", "c"]), policyName: "highest-score", weights: W, maxFallbacks: 2, clock: makeClock(), idGenerator: makeIdGen() });
    assert.equal(plan.primaryEndpoint.deviceId, "a");
    assert.equal(plan.status, PlanStatus.ACTIVE);
    assert.equal(plan.nat.reserved, true);
    assert.ok(!isPlanExpired(plan, makeClock()()));

    const routing = { primary: plan.primaryEndpoint, fallbacks: plan.fallbackEndpoints, priorityOrder: plan.priorityOrder, retryStrategy: plan.retryStrategy };
    const rer = rerouteFirst(routing, "c");
    assert.equal(rer.primary.deviceId, "c");
    assert.equal(rer.priorityOrder[0], "c");
  });

  it("describeSelection summarizes the top dimensions; planCacheKey is candidate-set aware", () => {
    const ep = toEndpoint(ranked(["a"])[0]);
    assert.ok(describeSelection(ep, "highest-score").startsWith("highest-score"));
    const k1 = planCacheKey({ requester: "u1", requesterDevice: "d1", targetUser: "u2", policyName: "p", candidateIds: ["b", "a"] });
    const k2 = planCacheKey({ requester: "u1", requesterDevice: "d1", targetUser: "u2", policyName: "p", candidateIds: ["a", "b"] });
    assert.equal(k1, k2);
  });
});

// ---------------------------------------------------------------------------
describe("failover", () => {
  const planOf = (ids) => createEndpointConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", ranked: rankEndpoints(ids.map((id) => candidate(id)), { now: 1 }, W), policyName: "highest-score", weights: W, maxFallbacks: 3, clock: makeClock(), idGenerator: makeIdGen() });

  it("applyFailover promotes the next fallback", () => {
    const plan = planOf(["a", "b", "c"]);
    const { plan: next, failedDevice, promotedDevice } = applyFailover(plan, { reason: "timeout" });
    assert.equal(failedDevice, "a");
    assert.equal(promotedDevice, "b");
    assert.equal(next.primaryEndpoint.deviceId, "b");
    assert.equal(next.status, PlanStatus.FAILED_OVER);
    assert.equal(next.generation, 1);
    assert.deepEqual(next.priorityOrder, ["b", "c"]);
  });

  it("applyFailover throws with no fallback; markExhausted flags it", () => {
    const plan = planOf(["solo"]);
    assert.throws(() => applyFailover(plan), NoFallbackError);
    assert.equal(markExhausted(plan).status, PlanStatus.EXHAUSTED);
  });

  it("refreshRouting rebuilds from fresh candidates + bumps generation", () => {
    const plan = planOf(["a", "b"]);
    const refreshed = refreshRouting(plan, rankEndpoints([candidate("c"), candidate("d")], { now: 1 }, W));
    assert.equal(refreshed.primaryEndpoint.deviceId, "c");
    assert.equal(refreshed.generation, 1);
    assert.equal(refreshed.status, PlanStatus.ACTIVE);
  });
});
