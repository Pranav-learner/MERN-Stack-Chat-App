/**
 * Discovery lifecycle, state machine, manager, events, and API-facade tests
 * (Layer 6, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeDiscovery, seedUser, recordEvents, makeClock, makeIdGen } from "./helpers.js";
import {
  DiscoveryLifecycle,
  ALLOWED_DISCOVERY_TRANSITIONS,
  canDiscoveryTransition,
  assertDiscoveryTransition,
  nextDiscoveryStates,
} from "../lifecycle/lifecycle.js";
import {
  createDiscoverySession,
  inferLookupType,
  discoveryDedupeKey,
  isDiscoverySessionExpired,
  isDiscoverySessionTerminal,
} from "../session/discoverySession.js";
import { createDiscoveryApi } from "../api/discoveryApi.js";
import {
  DiscoveryState,
  LookupType,
  DiscoverySource,
  DiscoveryEventType,
  DiscoveryFailureReason,
  ALL_DISCOVERY_STATES,
  TERMINAL_DISCOVERY_STATES,
} from "../types/types.js";
import {
  InvalidDiscoveryTransitionError,
  DiscoveryNotFoundError,
  UnauthorizedDiscoveryError,
  DiscoveryError,
} from "../errors.js";

// ---------------------------------------------------------------------------
describe("state machine — transitions", () => {
  it("allows the happy path CREATED→PENDING→SEARCHING→RESOLVED→COMPLETED", () => {
    assert.ok(canDiscoveryTransition(DiscoveryState.CREATED, DiscoveryState.PENDING));
    assert.ok(canDiscoveryTransition(DiscoveryState.PENDING, DiscoveryState.SEARCHING));
    assert.ok(canDiscoveryTransition(DiscoveryState.SEARCHING, DiscoveryState.RESOLVED));
    assert.ok(canDiscoveryTransition(DiscoveryState.RESOLVED, DiscoveryState.COMPLETED));
  });

  it("rejects illegal + terminal transitions", () => {
    assert.ok(!canDiscoveryTransition(DiscoveryState.CREATED, DiscoveryState.RESOLVED));
    assert.ok(!canDiscoveryTransition(DiscoveryState.RESOLVED, DiscoveryState.SEARCHING));
    assert.ok(!canDiscoveryTransition(DiscoveryState.COMPLETED, DiscoveryState.PENDING));
    assert.throws(() => assertDiscoveryTransition(DiscoveryState.FAILED, DiscoveryState.RESOLVED), InvalidDiscoveryTransitionError);
  });

  it("every terminal state is a dead end", () => {
    for (const t of TERMINAL_DISCOVERY_STATES) {
      assert.deepEqual(nextDiscoveryStates(t), [], `${t} should have no successors`);
    }
  });

  it("every declared state has a transition table entry", () => {
    for (const s of ALL_DISCOVERY_STATES) {
      assert.ok(s in ALLOWED_DISCOVERY_TRANSITIONS, `${s} missing from transition table`);
    }
  });

  it("DiscoveryLifecycle records history and enforces legality", () => {
    const fsm = new DiscoveryLifecycle(DiscoveryState.CREATED, { clock: makeClock() });
    fsm.transition(DiscoveryState.PENDING);
    fsm.transition(DiscoveryState.SEARCHING, { reason: "looking" });
    fsm.transition(DiscoveryState.RESOLVED);
    assert.equal(fsm.state, DiscoveryState.RESOLVED);
    assert.equal(fsm.history.length, 3);
    assert.equal(fsm.history[1].reason, "looking");
    assert.ok(fsm.can(DiscoveryState.COMPLETED));
    assert.throws(() => fsm.transition(DiscoveryState.PENDING), InvalidDiscoveryTransitionError);
  });

  it("DiscoveryLifecycle rejects an unknown initial state", () => {
    assert.throws(() => new DiscoveryLifecycle("bogus"), InvalidDiscoveryTransitionError);
  });
});

// ---------------------------------------------------------------------------
describe("session model helpers", () => {
  it("infers lookup type from device count", () => {
    assert.equal(inferLookupType([]), LookupType.USER);
    assert.equal(inferLookupType(["d1"]), LookupType.DEVICE);
    assert.equal(inferLookupType(["d1", "d2"]), LookupType.DEVICES);
  });

  it("creates a CREATED session with expiry + audit history", () => {
    const clock = makeClock();
    const s = createDiscoverySession({ requester: "u1", targetUser: "u2", ttlMs: 5000, clock, idGenerator: makeIdGen() });
    assert.equal(s.state, DiscoveryState.CREATED);
    assert.equal(new Date(s.expiresAt).getTime(), clock() + 5000);
    assert.equal(s.history[0].to, DiscoveryState.CREATED);
    assert.equal(s.result, null);
  });

  it("dedupe key is stable regardless of device order", () => {
    const a = discoveryDedupeKey({ requester: "u1", targetUser: "u2", targetDevices: ["d2", "d1"] });
    const b = discoveryDedupeKey({ requester: "u1", targetUser: "u2", targetDevices: ["d1", "d2"] });
    assert.equal(a, b);
  });

  it("expiry + terminal predicates", () => {
    const clock = makeClock();
    const s = createDiscoverySession({ requester: "u1", targetUser: "u2", ttlMs: 1000, clock, idGenerator: makeIdGen() });
    assert.ok(!isDiscoverySessionExpired(s, clock()));
    assert.ok(isDiscoverySessionExpired(s, clock() + 2000));
    assert.ok(!isDiscoverySessionTerminal(s));
    assert.ok(isDiscoverySessionTerminal({ state: DiscoveryState.FAILED }));
  });
});

// ---------------------------------------------------------------------------
describe("manager — lookups + lifecycle", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeDiscovery({ seed: seedUser("u2", 3) });
  });

  it("lookupUser resolves identity + all devices and drives the full state machine", async () => {
    const events = recordEvents(ctx.events);
    const { session, metadata } = await ctx.manager.lookupUser({ requester: "u1", targetUser: "u2" });

    assert.equal(session.state, DiscoveryState.RESOLVED);
    assert.equal(session.isResolved, true);
    assert.equal(metadata.userId, "u2");
    assert.equal(metadata.devices.length, 3);
    assert.equal(metadata.publicIdentity.identityId, "id-u2");
    assert.equal(metadata.source, DiscoverySource.DIRECTORY);

    // Events fired in order: started → searching → resolved (+ cached).
    const types = events.types();
    assert.ok(types.includes(DiscoveryEventType.STARTED));
    assert.ok(types.includes(DiscoveryEventType.SEARCHING));
    assert.ok(types.includes(DiscoveryEventType.RESOLVED));
    assert.ok(types.includes(DiscoveryEventType.CACHED));
  });

  it("lookupDevice resolves a single device", async () => {
    const { session, metadata } = await ctx.manager.lookupDevice({ requester: "u1", targetUser: "u2", deviceId: "d2" });
    assert.equal(session.lookupType, LookupType.DEVICE);
    assert.deepEqual(metadata.deviceIds, ["d2"]);
  });

  it("lookupDevices resolves a chosen subset", async () => {
    const { metadata } = await ctx.manager.lookupDevices({ requester: "u1", targetUser: "u2", deviceIds: ["d1", "d3"] });
    assert.deepEqual(metadata.deviceIds.sort(), ["d1", "d3"]);
  });

  it("createDiscoverySession stages a PENDING session without resolving", async () => {
    const session = await ctx.manager.createDiscoverySession({ requester: "u1", targetUser: "u2" });
    assert.equal(session.state, DiscoveryState.PENDING);
    assert.equal(session.result, null);
  });

  it("completeDiscovery only works from RESOLVED, is requester-scoped", async () => {
    const { session } = await ctx.manager.lookupUser({ requester: "u1", targetUser: "u2" });
    await assert.rejects(() => ctx.manager.completeDiscovery(session.discoveryId, { actingUser: "intruder" }), UnauthorizedDiscoveryError);
    const done = await ctx.manager.completeDiscovery(session.discoveryId, { actingUser: "u1" });
    assert.equal(done.state, DiscoveryState.COMPLETED);
    // Completing again (now terminal) is rejected.
    await assert.rejects(() => ctx.manager.completeDiscovery(session.discoveryId, { actingUser: "u1" }), DiscoveryError);
  });

  it("cancelDiscovery moves an active session to CANCELLED and emits", async () => {
    const events = recordEvents(ctx.events);
    const session = await ctx.manager.createDiscoverySession({ requester: "u1", targetUser: "u2" });
    const cancelled = await ctx.manager.cancelDiscovery(session.discoveryId, { actingUser: "u1", reason: "user-abort" });
    assert.equal(cancelled.state, DiscoveryState.CANCELLED);
    assert.equal(cancelled.failureReason, DiscoveryFailureReason.CANCELLED);
    assert.equal(events.ofType(DiscoveryEventType.CANCELLED).length, 1);
  });

  it("unknown user yields a FAILED session (not a throw) + negative cache", async () => {
    const events = recordEvents(ctx.events);
    const { session, metadata } = await ctx.manager.lookupUser({ requester: "u1", targetUser: "ghost" });
    assert.equal(session.state, DiscoveryState.FAILED);
    assert.equal(session.failureReason, DiscoveryFailureReason.UNKNOWN_USER);
    assert.equal(metadata, null);
    assert.equal(events.ofType(DiscoveryEventType.FAILED).length, 1);

    // The negative result is cached: the second lookup is served from the negative cache.
    const again = await ctx.manager.lookupUser({ requester: "u9", targetUser: "ghost" });
    assert.equal(again.session.failureReason, DiscoveryFailureReason.UNKNOWN_USER);
  });

  it("getDiscovery / getDiscoveryStatus enforce the requester", async () => {
    const { session } = await ctx.manager.lookupUser({ requester: "u1", targetUser: "u2" });
    await assert.rejects(() => ctx.manager.getDiscovery(session.discoveryId, { actingUser: "other" }), UnauthorizedDiscoveryError);
    const status = await ctx.manager.getDiscoveryStatus(session.discoveryId, { actingUser: "u1" });
    assert.equal(status.state, DiscoveryState.RESOLVED);
    assert.equal(status.deviceCount, 3);
  });

  it("listDiscoveries / listActiveDiscoveries scope to the requester", async () => {
    await ctx.manager.lookupUser({ requester: "u1", targetUser: "u2" });
    await ctx.manager.createDiscoverySession({ requester: "u1", targetUser: "u2", targetDevices: ["d1"] });
    await ctx.manager.lookupUser({ requester: "rival", targetUser: "u2" });

    const all = await ctx.manager.listDiscoveries("u1");
    assert.equal(all.length, 2);
    const active = await ctx.manager.listActiveDiscoveries("u1");
    // The resolved lookup + the pending staged session are both still active.
    assert.ok(active.length >= 1);
    assert.ok(active.every((d) => d.targetUser === "u2"));
  });

  it("getDiscovery on a missing id throws NotFound", async () => {
    await assert.rejects(() => ctx.manager.getDiscovery("does-not-exist-000", {}), DiscoveryNotFoundError);
  });

  it("registerDevice invalidates the user's cache so the next fresh lookup sees the new device", async () => {
    await ctx.manager.lookupUser({ requester: "u1", targetUser: "u2" }); // warm cache (3 devices)
    await ctx.manager.registerDevice({ userId: "u2", deviceId: "d4", publicKey: "PUB-d4", fingerprint: "fp-d4" });
    // A DIFFERENT requester issues a fresh lookup (no in-flight resolved session to adopt) → it
    // misses the invalidated cache and re-resolves from the registry, now including d4.
    const { metadata } = await ctx.manager.lookupUser({ requester: "observer", targetUser: "u2" });
    assert.ok(metadata.deviceIds.includes("d4"));
  });

  it("deregisterDevice removes a self-registered descriptor", async () => {
    await ctx.manager.registerDevice({ userId: "solo", deviceId: "only", publicKey: "P", fingerprint: "F" });
    const before = await ctx.manager.lookupUser({ requester: "u1", targetUser: "solo" });
    assert.equal(before.metadata.devices.length, 1);
    assert.equal(await ctx.manager.deregisterDevice("solo", "only"), true);
    const after = await ctx.manager.lookupUser({ requester: "observer", targetUser: "solo" });
    assert.equal(after.session.state, DiscoveryState.FAILED); // no identity + no devices
  });
});

// ---------------------------------------------------------------------------
describe("manager — expiration sweeps", () => {
  it("sweepExpired transitions overdue active sessions to EXPIRED", async () => {
    const clock = makeClock();
    const ctx = makeDiscovery({ seed: seedUser("u2", 1), clock });
    const events = recordEvents(ctx.events);
    const staged = await ctx.manager.createDiscoverySession({ requester: "u1", targetUser: "u2", ttlMs: 1000 });

    clock.advance(2000);
    const { expired } = await ctx.manager.sweepExpired();
    assert.equal(expired, 1);
    const status = await ctx.manager.getDiscoveryStatus(staged.discoveryId, { actingUser: "u1" });
    assert.equal(status.state, DiscoveryState.EXPIRED);
    assert.equal(events.ofType(DiscoveryEventType.EXPIRED).length, 1);
  });

  it("getDiscovery lazily expires an overdue session on read", async () => {
    const clock = makeClock();
    const ctx = makeDiscovery({ seed: seedUser("u2", 1), clock });
    const staged = await ctx.manager.createDiscoverySession({ requester: "u1", targetUser: "u2", ttlMs: 1000 });
    clock.advance(5000);
    const view = await ctx.manager.getDiscovery(staged.discoveryId, { actingUser: "u1" });
    assert.equal(view.state, DiscoveryState.EXPIRED);
  });
});

// ---------------------------------------------------------------------------
describe("API facade", () => {
  let ctx, api;
  beforeEach(() => {
    ctx = makeDiscovery({ seed: seedUser("u2", 2) });
    api = createDiscoveryApi(ctx.manager);
  });

  it("requires an actingUser on every call", async () => {
    await assert.rejects(() => api.lookupUser({ targetUser: "u2" }), /actingUser is required/);
  });

  it("lookupUser → getStatus → complete round-trips through the facade", async () => {
    const { session, metadata } = await api.lookupUser({ actingUser: "u1", targetUser: "u2" });
    assert.equal(metadata.devices.length, 2);
    const status = await api.getStatus({ actingUser: "u1", discoveryId: session.discoveryId });
    assert.equal(status.isResolved, true);
    const done = await api.complete({ actingUser: "u1", discoveryId: session.discoveryId });
    assert.equal(done.state, DiscoveryState.COMPLETED);
  });

  it("createSession + cancel + listActive via the facade", async () => {
    const { session } = await api.createSession({ actingUser: "u1", targetUser: "u2", targetDevices: ["d1"] });
    const active = await api.listActive({ actingUser: "u1" });
    assert.equal(active.length, 1);
    const cancelled = await api.cancel({ actingUser: "u1", discoveryId: session.discoveryId, reason: "changed-mind" });
    assert.equal(cancelled.state, DiscoveryState.CANCELLED);
  });

  it("exposes the underlying manager as an escape hatch", () => {
    assert.equal(api.manager, ctx.manager);
  });
});
