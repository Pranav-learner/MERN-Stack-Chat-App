/**
 * Endpoint Selection manager, policies integration, failover, reliability, cache, and API-facade
 * tests (Layer 6, Sprint 5). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeClock, cap, candidate, recordEvents } from "./helpers.js";
import { createEndpointApi } from "../api/endpointApi.js";
import { EndpointCache, EndpointCacheOutcome } from "../cache/cache.js";
import { SelectionPolicy, EndpointEventType, EndpointSource, PlanStatus, OutcomeType } from "../types/types.js";
import { SelectionFailedError, NoFallbackError, UnauthorizedEndpointError, EndpointNotFoundError } from "../errors.js";

/** laptop (rich desktop), phone (relay-only mobile), tablet (away). */
function trio(clock) {
  const now = clock ? clock() : 1_700_000_000_000;
  return [
    candidate("laptop", { platform: "web", lastSeen: new Date(now).toISOString(), capabilities: cap() }),
    candidate("phone", { platform: "ios", lastSeen: new Date(now).toISOString(), capabilities: cap({ sharedTransports: ["relay"], preferredTransport: "relay", fallbackChain: [] }) }),
    candidate("tablet", { platform: "android", presenceStatus: "away", lastSeen: new Date(now - 120000).toISOString(), capabilities: cap({ sharedTransports: ["relay", "websocket"], preferredTransport: "relay" }) }),
  ];
}

// ---------------------------------------------------------------------------
describe("manager — generate + rank", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("generates an optimized plan (primary + fallbacks) + emits", async () => {
    const log = recordEvents(ctx.events);
    const { plan, ranking, source } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    assert.equal(plan.primaryEndpoint.deviceId, "laptop"); // richest + online + desktop
    assert.equal(plan.fallbackEndpoints.length, 2);
    assert.deepEqual(plan.priorityOrder, ["laptop", "phone", "tablet"]);
    assert.equal(plan.preferredTransport, "webrtc");
    assert.equal(source, EndpointSource.COMPUTED);
    assert.equal(ranking.length, 3);

    const types = new Set(log.types());
    for (const e of [EndpointEventType.SELECTION_POLICY_APPLIED, EndpointEventType.ENDPOINT_RANKED, EndpointEventType.PRIMARY_ENDPOINT_SELECTED, EndpointEventType.FALLBACK_GENERATED, EndpointEventType.CONNECTION_PLAN_CREATED]) {
      assert.ok(types.has(e), `missing ${e}`);
    }
  });

  it("rankDevices ranks without producing a plan", async () => {
    const { ranking, policy } = await ctx.manager.rankDevices({ requester: "u1", targetUser: "u2", candidates: trio() });
    assert.equal(policy, SelectionPolicy.HIGHEST_SCORE);
    assert.equal(ranking[0].deviceId, "laptop");
    assert.ok(ranking[0].score >= ranking[1].score);
  });

  it("selectEndpoint returns just the primary", async () => {
    const primary = await ctx.manager.selectEndpoint({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    assert.equal(primary.deviceId, "laptop");
  });

  it("single-device: primary with no fallbacks", async () => {
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("only")] });
    assert.equal(plan.primaryEndpoint.deviceId, "only");
    assert.equal(plan.fallbackEndpoints.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("manager — policies steer selection", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  const gen = (policy, extra = {}) => ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio(), policy, ...extra }, { useCache: false });

  it("desktop-preferred → laptop; mobile-preferred → a mobile device", async () => {
    assert.equal((await gen("desktop-preferred")).plan.primaryEndpoint.deviceId, "laptop");
    assert.equal((await gen("mobile-preferred")).plan.primaryEndpoint.deviceId, "phone"); // online mobile beats away tablet
  });

  it("battery-friendly prefers desktop (spares mobile battery)", async () => {
    assert.equal((await gen("battery-friendly")).plan.primaryEndpoint.deviceId, "laptop");
  });

  it("most-recently-active prefers the freshest device", async () => {
    const { plan } = await gen("most-recently-active");
    assert.ok(["laptop", "phone"].includes(plan.primaryEndpoint.deviceId)); // both freshest; tablet is stale
    assert.notEqual(plan.primaryEndpoint.deviceId, "tablet");
  });

  it("manual-preference pins a requested device", async () => {
    const { plan } = await gen("manual-preference", { preferredDeviceId: "tablet" });
    assert.equal(plan.primaryEndpoint.deviceId, "tablet");
  });

  it("preferred-platform prefers the requested platform", async () => {
    const { plan } = await gen("preferred-platform", { preferredPlatform: "ios" });
    assert.equal(plan.primaryEndpoint.deviceId, "phone");
  });

  it("a custom weight profile is honored", async () => {
    const { plan } = await gen({ name: "custom", weights: { userPreference: 10 } }, { preferredDeviceId: "phone" });
    assert.equal(plan.primaryEndpoint.deviceId, "phone");
  });
});

// ---------------------------------------------------------------------------
describe("manager — failover + reliability + refresh", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("failover promotes the next fallback + records the primary as failed", async () => {
    const log = recordEvents(ctx.events);
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    const failed = await ctx.manager.failover(plan.planId, { actingUser: "u1", reason: "timeout" });
    assert.equal(failed.primaryEndpoint.deviceId, "phone");
    assert.equal(failed.status, PlanStatus.FAILED_OVER);
    assert.equal(failed.generation, 1);
    const rel = await ctx.repo.reliability.get("u2", "laptop");
    assert.equal(rel.failures, 1); // failed primary recorded
    assert.ok(log.ofType(EndpointEventType.ROUTING_UPDATED).length >= 1);
  });

  it("failover with no fallback throws + marks the plan EXHAUSTED", async () => {
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("solo")] });
    await assert.rejects(() => ctx.manager.failover(plan.planId, { actingUser: "u1" }), NoFallbackError);
    const got = await ctx.manager.getConnectionPlan(plan.planId, { actingUser: "u1" });
    assert.equal(got.plan.status, PlanStatus.EXHAUSTED);
  });

  it("recordOutcome updates reliability, raising a device's future score", async () => {
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    for (let i = 0; i < 5; i++) await ctx.manager.recordOutcome(plan.planId, "phone", OutcomeType.SUCCESS, { actingUser: "u1" });
    const rel = await ctx.repo.reliability.get("u2", "phone");
    assert.equal(rel.successes, 5);
    assert.ok(rel.reliability > 0.5);
  });

  it("refreshPlan rebuilds routing from fresh candidates (device recovery)", async () => {
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("laptop")] });
    // A new, richer device appears; refresh picks it up.
    const refreshed = await ctx.manager.refreshPlan(plan.planId, { actingUser: "u1", candidates: [candidate("laptop"), candidate("workstation", { capabilities: cap({ sharedTransports: ["webrtc", "quic", "relay", "websocket"] }) })] });
    assert.equal(refreshed.generation, 1);
    assert.equal(refreshed.priorityOrder.length, 2);
  });

  it("updateRouting reroutes to a specific device (alternative routing)", async () => {
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    const rerouted = await ctx.manager.updateRouting(plan.planId, "tablet", { actingUser: "u1" });
    assert.equal(rerouted.primaryEndpoint.deviceId, "tablet");
    assert.equal(rerouted.priorityOrder[0], "tablet");
  });
});

// ---------------------------------------------------------------------------
describe("manager — selection failures + auth + cache", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("no reachable endpoint → SelectionFailedError(no-reachable-endpoint)", async () => {
    await assert.rejects(
      () => ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("off", { presenceStatus: "offline" })] }),
      (e) => e instanceof SelectionFailedError && e.reason === "no-reachable-endpoint",
    );
  });

  it("reachable but incompatible → SelectionFailedError(no-compatible-endpoint)", async () => {
    await assert.rejects(
      () => ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("inc", { capabilities: { compatible: false } })] }),
      (e) => e instanceof SelectionFailedError && e.reason === "no-compatible-endpoint",
    );
  });

  it("second identical generate is a cache hit; a write invalidates", async () => {
    const first = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    assert.equal(first.source, EndpointSource.COMPUTED);
    const second = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    assert.equal(second.source, EndpointSource.CACHE);
    // recordOutcome invalidates the target's cached plans.
    await ctx.manager.recordOutcome(first.plan.planId, "laptop", OutcomeType.SUCCESS, { actingUser: "u1" });
    const third = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    assert.equal(third.source, EndpointSource.COMPUTED);
  });

  it("ownership + not-found guards", async () => {
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    await assert.rejects(() => ctx.manager.getConnectionPlan(plan.planId, { actingUser: "intruder" }), UnauthorizedEndpointError);
    await assert.rejects(() => ctx.manager.getConnectionPlan("missing-00000000", {}), EndpointNotFoundError);
  });
});

// ---------------------------------------------------------------------------
describe("cache", () => {
  it("miss → set → hit → expire; plan expiry caps TTL; invalidateTarget", () => {
    const clock = makeClock();
    const cache = new EndpointCache({ clock, ttlMs: 1000, limit: 2 });
    assert.equal(cache.get("k").outcome, EndpointCacheOutcome.MISS);
    cache.set("k", { planId: "p", requester: "u1", targetUser: "u2", expiresAt: new Date(clock() + 5000).toISOString() });
    assert.equal(cache.get("k").outcome, EndpointCacheOutcome.HIT);
    clock.advance(1000);
    assert.equal(cache.get("k").outcome, EndpointCacheOutcome.EXPIRED);

    cache.set("a", { requester: "u1", targetUser: "u2" });
    cache.set("b", { requester: "u1", targetUser: "u3" });
    assert.equal(cache.invalidateTarget("u2"), 1);
    cache.set("c", { requester: "u9", targetUser: "z" });
    cache.set("d", { requester: "u9", targetUser: "z" }); // over limit 2
    assert.ok(cache.stats().evictions >= 1);
  });
});

// ---------------------------------------------------------------------------
describe("API facade", () => {
  let ctx, api;
  beforeEach(() => {
    ctx = makeManager();
    api = createEndpointApi(ctx.manager);
  });

  it("requires an actingUser", async () => {
    await assert.rejects(() => api.generatePlan({ requesterDevice: "d1", targetUser: "u2", candidates: trio() }), /actingUser is required/);
  });

  it("generatePlan → getFallbacks → failover → getStatus round-trips", async () => {
    const { plan } = await api.generatePlan({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    const fallbacks = await api.getFallbacks({ actingUser: "u1", planId: plan.planId });
    assert.equal(fallbacks.length, 2);
    const failed = await api.failover({ actingUser: "u1", planId: plan.planId });
    assert.equal(failed.primaryEndpoint.deviceId, "phone");
    const status = await api.getStatus({ actingUser: "u1", planId: plan.planId });
    assert.equal(status.status, PlanStatus.FAILED_OVER);
  });

  it("rankDevices + history + exposes the manager", async () => {
    const { ranking } = await api.rankDevices({ actingUser: "u1", targetUser: "u2", candidates: trio() });
    assert.equal(ranking[0].deviceId, "laptop");
    await api.generatePlan({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2", candidates: trio() });
    assert.ok((await api.history({ actingUser: "u1" })).length >= 1);
    assert.equal(api.manager, ctx.manager);
  });
});
