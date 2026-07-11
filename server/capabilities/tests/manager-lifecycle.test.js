/**
 * Capability manager, lifecycle, caching, events, and API-facade tests (Layer 6, Sprint 3).
 * DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeCapabilities, makeClock, caps, recordEvents } from "./helpers.js";
import {
  CapabilityLifecycle,
  ALLOWED_CAPABILITY_TRANSITIONS,
  canCapabilityTransition,
  assertCapabilityTransition,
  nextCapabilityStates,
  isTerminalCapabilityState,
} from "../lifecycle/lifecycle.js";
import { createCapabilityApi } from "../api/capabilityApi.js";
import { CapabilityCache, CapabilityCacheOutcome } from "../cache/cache.js";
import {
  CapabilityState,
  CapabilityEventType,
  CapabilitySource,
  CapabilityFailureReason,
  TransportType,
} from "../types/types.js";
import {
  InvalidCapabilityTransitionError,
  DuplicateCapabilityError,
  UnauthorizedCapabilityError,
  CapabilityNotFoundError,
  CapabilityExpiredError,
} from "../errors.js";

// ---------------------------------------------------------------------------
describe("capability lifecycle state machine", () => {
  it("allows register→advertise, updates in place, expiry + revival", () => {
    assert.ok(canCapabilityTransition(CapabilityState.REGISTERED, CapabilityState.ADVERTISED));
    assert.ok(canCapabilityTransition(CapabilityState.ADVERTISED, CapabilityState.ADVERTISED)); // self (update)
    assert.ok(canCapabilityTransition(CapabilityState.ADVERTISED, CapabilityState.EXPIRED));
    assert.ok(canCapabilityTransition(CapabilityState.EXPIRED, CapabilityState.ADVERTISED)); // revive
  });

  it("REMOVED is terminal; illegal jumps throw", () => {
    assert.deepEqual(nextCapabilityStates(CapabilityState.REMOVED), []);
    assert.ok(isTerminalCapabilityState(CapabilityState.REMOVED));
    assert.throws(() => assertCapabilityTransition(CapabilityState.REMOVED, CapabilityState.ADVERTISED), InvalidCapabilityTransitionError);
    assert.throws(() => assertCapabilityTransition(CapabilityState.ADVERTISED, "bogus"), InvalidCapabilityTransitionError);
  });

  it("every state has a transition entry; driver records history", () => {
    for (const s of Object.values(CapabilityState)) assert.ok(s in ALLOWED_CAPABILITY_TRANSITIONS);
    const fsm = new CapabilityLifecycle(CapabilityState.REGISTERED, { clock: makeClock() });
    fsm.transition(CapabilityState.ADVERTISED);
    fsm.transition(CapabilityState.EXPIRED, { reason: "ttl" });
    assert.equal(fsm.state, CapabilityState.EXPIRED);
    assert.equal(fsm.history.length, 2);
    assert.ok(fsm.isTerminal === false);
  });
});

// ---------------------------------------------------------------------------
describe("manager — registration + updates", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeCapabilities();
  });

  it("registers → advertised, advertises, and emits", async () => {
    const log = recordEvents(ctx.events);
    const c = await ctx.manager.registerCapabilities(caps("u1", "d1"));
    assert.equal(c.state, CapabilityState.ADVERTISED);
    assert.equal(c.negotiable, true);
    assert.equal(c.version, 1);
    const types = log.types();
    assert.ok(types.includes(CapabilityEventType.REGISTERED));
    assert.ok(types.includes(CapabilityEventType.ADVERTISED));
  });

  it("rejects a duplicate live registration", async () => {
    await ctx.manager.registerCapabilities(caps("u1", "d1"));
    await assert.rejects(() => ctx.manager.registerCapabilities(caps("u1", "d1")), DuplicateCapabilityError);
  });

  it("update bumps version + re-normalizes fields + records history", async () => {
    const c = await ctx.manager.registerCapabilities(caps("u1", "d1"));
    const updated = await ctx.manager.updateCapabilities(c.capabilityId, { actingUser: "u1", transports: ["quic", "websocket"], featureFlags: { typing: true } });
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.transports, ["quic", "websocket"]);
    const full = await ctx.manager.getCapabilities(c.capabilityId, { actingUser: "u1", includeHistory: true });
    assert.ok(full.versionHistory.length >= 2);
  });

  it("enforces ownership on update/remove", async () => {
    const c = await ctx.manager.registerCapabilities(caps("u1", "d1"));
    await assert.rejects(() => ctx.manager.updateCapabilities(c.capabilityId, { actingUser: "intruder", transports: ["relay"] }), UnauthorizedCapabilityError);
    await assert.rejects(() => ctx.manager.removeCapabilities(c.capabilityId, { actingUser: "intruder" }), UnauthorizedCapabilityError);
  });

  it("supports multiple devices per user", async () => {
    await ctx.manager.registerCapabilities(caps("u1", "d1"));
    await ctx.manager.registerCapabilities(caps("u1", "d2", { transports: ["relay"] }));
    const list = await ctx.manager.listUserCapabilities("u1");
    assert.equal(list.length, 2);
  });

  it("refresh extends TTL + revives an expired set; remove deletes", async () => {
    const clock = makeClock();
    const ctx2 = makeCapabilities({ clock });
    const c = await ctx2.manager.registerCapabilities(caps("u1", "d1", { ttlMs: 1000 }));
    clock.advance(2000);
    await ctx2.manager.sweepExpired();
    const refreshed = await ctx2.manager.refreshCapabilities(c.capabilityId, { actingUser: "u1" });
    assert.equal(refreshed.state, CapabilityState.ADVERTISED);
    const { removed } = await ctx2.manager.removeCapabilities(c.capabilityId, { actingUser: "u1" });
    assert.equal(removed, true);
    await assert.rejects(() => ctx2.manager.getCapabilities(c.capabilityId, {}), CapabilityNotFoundError);
  });
});

// ---------------------------------------------------------------------------
describe("manager — negotiation + caching + history", () => {
  let ctx;
  beforeEach(async () => {
    ctx = makeCapabilities();
    await ctx.manager.registerCapabilities(caps("u1", "d1", { transports: ["webrtc", "websocket", "relay"], compression: ["brotli", "gzip"], maxPayloadSize: 2000, featureFlags: { typing: true, reactions: true } }));
    await ctx.manager.registerCapabilities(caps("u2", "d1", { transports: ["websocket", "relay"], compression: ["gzip"], maxPayloadSize: 500, featureFlags: { typing: true, receipts: true } }));
  });

  it("negotiates two devices into a compatible plan + records history + emits", async () => {
    const log = recordEvents(ctx.events);
    const { result, source, negotiationId } = await ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(result.compatible, true);
    assert.equal(result.preferredTransport, "relay");
    assert.equal(result.maxPayloadSize, 500);
    assert.deepEqual(result.featureFlags, { typing: true });
    assert.equal(source, CapabilitySource.COMPUTED);
    assert.ok(negotiationId);
    assert.ok(log.ofType(CapabilityEventType.NEGOTIATION_SUCCEEDED).length === 1);
    assert.ok(log.ofType(CapabilityEventType.PREFERRED_TRANSPORT_SELECTED).length === 1);

    const history = await ctx.manager.getNegotiationHistory("u1", "d1");
    assert.equal(history.length, 1);
    assert.equal(history[0].result.preferredTransport, "relay");
  });

  it("second negotiation is a cache hit; a capability update invalidates it", async () => {
    const first = await ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(first.source, CapabilitySource.COMPUTED);
    const second = await ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(second.source, CapabilitySource.CACHE);

    // Update u1's caps → the version-aware key changes AND the device cache is invalidated.
    const c1 = (await ctx.manager.listUserCapabilities("u1"))[0];
    await ctx.manager.updateCapabilities(c1.capabilityId, { actingUser: "u1", transports: ["websocket", "relay"] });
    const third = await ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(third.source, CapabilitySource.COMPUTED);
  });

  it("negotiation policy overrides the preferred transport", async () => {
    const ws = await ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1", policy: "prefer-websocket" });
    assert.equal(ws.result.preferredTransport, "websocket");
  });

  it("incompatible devices → failed negotiation (+ negative cache) not a throw", async () => {
    await ctx.manager.registerCapabilities(caps("u3", "d1", { transports: ["quic"] }));
    const log = recordEvents(ctx.events);
    const first = await ctx.manager.negotiate({ requester: "u3", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(first.result.compatible, false);
    assert.equal(first.result.failureReason, CapabilityFailureReason.NO_SHARED_TRANSPORT);
    assert.equal(log.ofType(CapabilityEventType.NEGOTIATION_FAILED).length, 1);
    const second = await ctx.manager.negotiate({ requester: "u3", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(second.source, CapabilitySource.NEGATIVE_CACHE);
  });

  it("resolvePreferredTransport is a thin convenience over negotiate", async () => {
    const pref = await ctx.manager.resolvePreferredTransport({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(pref.compatible, true);
    assert.equal(pref.preferredTransport, "relay");
    assert.deepEqual(pref.fallbackChain, ["websocket"]);
  });

  it("negotiating an unknown device throws NotFound; expired throws Expired", async () => {
    await assert.rejects(() => ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "ghost", targetDevice: "d1" }), CapabilityNotFoundError);
  });

  it("negotiating against an expired device surfaces an expiry error", async () => {
    const clock = makeClock();
    const c = makeCapabilities({ clock });
    await c.manager.registerCapabilities(caps("a", "d1", { ttlMs: 1000 }));
    await c.manager.registerCapabilities(caps("b", "d1", { ttlMs: 1_000_000 }));
    clock.advance(5000); // a expires
    await assert.rejects(() => c.manager.negotiate({ requester: "a", requesterDevice: "d1", targetUser: "b", targetDevice: "d1" }), CapabilityExpiredError);
  });
});

// ---------------------------------------------------------------------------
describe("manager — expiry sweeps", () => {
  it("sweepExpired transitions overdue live sets to EXPIRED + emits", async () => {
    const clock = makeClock();
    const ctx = makeCapabilities({ clock });
    const log = recordEvents(ctx.events);
    await ctx.manager.registerCapabilities(caps("u1", "d1", { ttlMs: 1000 }));
    await ctx.manager.registerCapabilities(caps("u2", "d1", { ttlMs: 1000 }));
    clock.advance(2000);
    const { expired } = await ctx.manager.sweepExpired();
    assert.equal(expired, 2);
    assert.equal(log.ofType(CapabilityEventType.EXPIRED).length, 2);
    assert.equal((await ctx.manager.countByState()).expired, 2);
  });

  it("lazily expires an overdue set on read", async () => {
    const clock = makeClock();
    const ctx = makeCapabilities({ clock });
    const c = await ctx.manager.registerCapabilities(caps("u1", "d1", { ttlMs: 1000 }));
    clock.advance(5000);
    const view = await ctx.manager.getCapabilities(c.capabilityId, {});
    assert.equal(view.state, CapabilityState.EXPIRED);
  });
});

// ---------------------------------------------------------------------------
describe("cache — version-aware behavior", () => {
  let clock, cache;
  beforeEach(() => {
    clock = makeClock();
    cache = new CapabilityCache({ clock, ttlMs: 1000, negativeTtlMs: 200, limit: 3 });
  });

  it("miss → set → hit → expire", () => {
    assert.equal(cache.get("k1").outcome, CapabilityCacheOutcome.MISS);
    cache.set("k1", { compatible: true }, ["u:1", "v:1"]);
    assert.equal(cache.get("k1").outcome, CapabilityCacheOutcome.HIT);
    clock.advance(1000);
    assert.equal(cache.get("k1").outcome, CapabilityCacheOutcome.EXPIRED);
  });

  it("negative cache + invalidateDevice", () => {
    cache.setNegative("k2", ["u:1", "v:1"]);
    assert.equal(cache.get("k2").outcome, CapabilityCacheOutcome.NEGATIVE);
    cache.set("k3", { compatible: true }, ["u:1", "w:1"]);
    assert.equal(cache.invalidateDevice("u:1"), 2); // both entries touch u:1
    assert.equal(cache.get("k3").outcome, CapabilityCacheOutcome.MISS);
  });

  it("LRU eviction + stats", () => {
    cache.set("a", {}, []);
    cache.set("b", {}, []);
    cache.set("c", {}, []);
    cache.get("a");
    const { evicted } = cache.set("d", {}, []);
    assert.equal(evicted, "b");
    assert.ok(cache.stats().evictions >= 1);
  });
});

// ---------------------------------------------------------------------------
describe("API facade", () => {
  let ctx, api;
  beforeEach(() => {
    ctx = makeCapabilities();
    api = createCapabilityApi(ctx.manager);
  });

  it("requires an actingUser", async () => {
    await assert.rejects(() => api.register({ deviceId: "d1" }), /actingUser is required/);
  });

  it("register → negotiate → resolvePreferredTransport → history round-trips", async () => {
    await api.register({ actingUser: "u1", deviceId: "d1", transports: ["websocket", "relay"] });
    await api.register({ actingUser: "u2", deviceId: "d1", transports: ["relay"] });
    const { result } = await api.negotiate({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(result.preferredTransport, TransportType.RELAY);
    const pref = await api.resolvePreferredTransport({ actingUser: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(pref.preferredTransport, TransportType.RELAY);
    const history = await api.history({ actingUser: "u1", deviceId: "d1" });
    assert.ok(history.length >= 1);
  });

  it("update + refresh + remove via the facade", async () => {
    const c = await api.register({ actingUser: "u1", deviceId: "d1", transports: ["websocket"] });
    const up = await api.update({ actingUser: "u1", capabilityId: c.capabilityId, featureFlags: { typing: true } });
    assert.equal(up.version, 2);
    await api.refresh({ actingUser: "u1", capabilityId: c.capabilityId });
    const { removed } = await api.remove({ actingUser: "u1", capabilityId: c.capabilityId });
    assert.equal(removed, true);
  });

  it("exposes the manager", () => {
    assert.equal(api.manager, ctx.manager);
  });
});
