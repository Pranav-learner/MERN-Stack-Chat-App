/**
 * Presence lifecycle, state machine, manager, heartbeat, recovery, advertisement, and event
 * tests (Layer 6, Sprint 2). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makePresence, makeClock, makeIdGen, makeIdentity, recordEvents } from "./helpers.js";
import {
  PresenceLifecycle,
  ALLOWED_PRESENCE_TRANSITIONS,
  canPresenceTransition,
  assertPresenceTransition,
  nextPresenceStatuses,
} from "../lifecycle/lifecycle.js";
import {
  createPresenceRecord,
  isPresenceExpired,
  msUntilExpiry,
  presenceKey,
} from "../record/presenceRecord.js";
import {
  createDeviceAdvertisement,
  restampAdvertisement,
  createConnectionPlaceholder,
  createTransportPlaceholder,
} from "../advertisement/advertisement.js";
import {
  PresenceStatus,
  PresenceEventType,
  ALL_PRESENCE_STATUSES,
  isReachableStatus,
  isVisibleOnlineStatus,
} from "../types/types.js";
import {
  InvalidPresenceTransitionError,
  DuplicatePresenceError,
  UnauthorizedPresenceError,
  PresenceNotFoundError,
  PresenceValidationError,
} from "../errors.js";

// ---------------------------------------------------------------------------
describe("state machine — transitions", () => {
  it("allows connected-status switching + drops to offline/disconnected/expired", () => {
    assert.ok(canPresenceTransition(PresenceStatus.ONLINE, PresenceStatus.AWAY));
    assert.ok(canPresenceTransition(PresenceStatus.BUSY, PresenceStatus.INVISIBLE));
    assert.ok(canPresenceTransition(PresenceStatus.ONLINE, PresenceStatus.DISCONNECTED));
    assert.ok(canPresenceTransition(PresenceStatus.ONLINE, PresenceStatus.OFFLINE));
    assert.ok(canPresenceTransition(PresenceStatus.ONLINE, PresenceStatus.EXPIRED));
  });

  it("models reconnect + recovery paths", () => {
    assert.ok(canPresenceTransition(PresenceStatus.DISCONNECTED, PresenceStatus.RECONNECTING));
    assert.ok(canPresenceTransition(PresenceStatus.RECONNECTING, PresenceStatus.ONLINE));
    assert.ok(canPresenceTransition(PresenceStatus.EXPIRED, PresenceStatus.ONLINE)); // heartbeat recovery
    assert.ok(canPresenceTransition(PresenceStatus.OFFLINE, PresenceStatus.ONLINE)); // re-register
  });

  it("rejects nonsensical jumps", () => {
    // OFFLINE revives only to a connected status — not straight to disconnected/expired.
    assert.ok(!canPresenceTransition(PresenceStatus.OFFLINE, PresenceStatus.DISCONNECTED));
    assert.ok(!canPresenceTransition(PresenceStatus.OFFLINE, PresenceStatus.EXPIRED));
    assert.ok(!canPresenceTransition(PresenceStatus.EXPIRED, PresenceStatus.DISCONNECTED));
    assert.throws(() => assertPresenceTransition(PresenceStatus.ONLINE, "bogus"), InvalidPresenceTransitionError);
  });

  it("self-transition (idempotent heartbeat) is always allowed", () => {
    assert.ok(canPresenceTransition(PresenceStatus.ONLINE, PresenceStatus.ONLINE));
    assert.ok(canPresenceTransition(PresenceStatus.EXPIRED, PresenceStatus.EXPIRED));
  });

  it("every status has a transition table entry (except pure resting UNKNOWN target)", () => {
    for (const s of ALL_PRESENCE_STATUSES) {
      // UNKNOWN has no outbound-from map beyond initial; every other appears as a key.
      if (s === PresenceStatus.UNKNOWN) continue;
      assert.ok(s in ALLOWED_PRESENCE_TRANSITIONS, `${s} missing from transition table`);
    }
    assert.ok(PresenceStatus.UNKNOWN in ALLOWED_PRESENCE_TRANSITIONS);
  });

  it("PresenceLifecycle records history + enforces legality", () => {
    const fsm = new PresenceLifecycle(PresenceStatus.UNKNOWN, { clock: makeClock() });
    fsm.transition(PresenceStatus.ONLINE);
    fsm.transition(PresenceStatus.AWAY, { reason: "idle" });
    assert.equal(fsm.status, PresenceStatus.AWAY);
    assert.equal(fsm.history.length, 2);
    assert.equal(fsm.history[1].reason, "idle");
    assert.ok(fsm.next.includes(PresenceStatus.ONLINE));
    assert.throws(() => fsm.transition(PresenceStatus.EXPIRED) && fsm.transition(PresenceStatus.DISCONNECTED), InvalidPresenceTransitionError);
  });

  it("nextPresenceStatuses returns a copy", () => {
    const a = nextPresenceStatuses(PresenceStatus.ONLINE);
    a.push("x");
    assert.ok(!nextPresenceStatuses(PresenceStatus.ONLINE).includes("x"));
  });
});

// ---------------------------------------------------------------------------
describe("record + advertisement builders", () => {
  it("createPresenceRecord builds an online record with expiry + advertisement + history", () => {
    const clock = makeClock();
    const r = createPresenceRecord({ userId: "u1", deviceId: "d1", identity: makeIdentity("u1"), timeoutMs: 30_000, clock, idGenerator: makeIdGen() });
    assert.equal(r.status, PresenceStatus.ONLINE);
    assert.equal(new Date(r.expiresAt).getTime(), clock() + 30_000);
    assert.equal(r.advertisement.publicIdentity.publicKey, "IDPUB-u1-1");
    assert.equal(r.statusHistory[0].to, PresenceStatus.ONLINE);
    assert.equal(r.missedHeartbeats, 0);
  });

  it("presenceKey + expiry helpers", () => {
    assert.equal(presenceKey("u1", "d1"), "u1|d1");
    const clock = makeClock();
    const r = createPresenceRecord({ userId: "u1", deviceId: "d1", timeoutMs: 1000, clock });
    assert.ok(!isPresenceExpired(r, clock()));
    assert.ok(isPresenceExpired(r, clock() + 2000));
    assert.equal(msUntilExpiry(r, clock()), 1000);
  });

  it("advertisement carries public identity + inert placeholders, no secrets", () => {
    const ad = createDeviceAdvertisement({ userId: "u1", deviceId: "d1", identity: makeIdentity("u1"), platform: "web", softwareVersion: "1.2.3" });
    assert.equal(ad.publicIdentity.publicKey, "IDPUB-u1-1");
    assert.equal(ad.connection.reserved, true);
    assert.equal(ad.connection.enabled, false);
    assert.equal(ad.transport.enabled, false);
    assert.equal(ad.softwareVersion, "1.2.3");
  });

  it("restampAdvertisement bumps version + status", () => {
    const ad = createDeviceAdvertisement({ userId: "u1", deviceId: "d1", status: "online" });
    const re = restampAdvertisement(ad, "away", "2026-01-01T00:00:00.000Z");
    assert.equal(re.status, "away");
    assert.equal(re.version, 2);
    assert.equal(re.advertisedAt, "2026-01-01T00:00:00.000Z");
  });

  it("placeholders are inert + reserved", () => {
    for (const p of [createConnectionPlaceholder(), createTransportPlaceholder()]) {
      assert.equal(p.enabled, false);
      assert.equal(p.reserved, true);
    }
  });

  it("reachability + visibility helpers", () => {
    assert.ok(isReachableStatus(PresenceStatus.INVISIBLE));
    assert.ok(!isVisibleOnlineStatus(PresenceStatus.INVISIBLE));
    assert.ok(isVisibleOnlineStatus(PresenceStatus.ONLINE));
    assert.ok(!isReachableStatus(PresenceStatus.OFFLINE));
  });
});

// ---------------------------------------------------------------------------
describe("manager — registration + multi-device", () => {
  let ctx;
  beforeEach(() => {
    ctx = makePresence();
  });

  it("registers a device online + advertises it + emits", async () => {
    const log = recordEvents(ctx.events);
    const p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1", identity: makeIdentity("u1"), platform: "web" });
    assert.equal(p.status, PresenceStatus.ONLINE);
    assert.equal(p.online, true);
    assert.equal(p.advertisement.deviceId, "d1");
    const types = log.types();
    assert.ok(types.includes(PresenceEventType.REGISTERED));
    assert.ok(types.includes(PresenceEventType.DEVICE_ADVERTISED));
    assert.ok(types.includes(PresenceEventType.ONLINE));
  });

  it("supports multiple devices per user independently", async () => {
    await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    await ctx.manager.registerPresence({ userId: "u1", deviceId: "d2", status: PresenceStatus.BUSY });
    const devices = await ctx.manager.listUserDevices("u1");
    assert.equal(devices.length, 2);
    assert.deepEqual(devices.map((d) => d.status).sort(), ["busy", "online"]);
  });

  it("rejects a duplicate registration of a reachable device", async () => {
    await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    await assert.rejects(() => ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" }), DuplicatePresenceError);
  });

  it("revives a non-reachable device on re-registration (keeps presenceId)", async () => {
    const p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    await ctx.manager.markOffline(p.presenceId, { actingUser: "u1" });
    const revived = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1", status: PresenceStatus.ONLINE });
    assert.equal(revived.presenceId, p.presenceId); // same record revived
    assert.equal(revived.status, PresenceStatus.ONLINE);
    assert.ok(revived.version > p.version);
  });
});

// ---------------------------------------------------------------------------
describe("manager — status updates", () => {
  let ctx, p;
  beforeEach(async () => {
    ctx = makePresence();
    p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
  });

  it("updates to a user-settable status + restamps the advertisement", async () => {
    const updated = await ctx.manager.updatePresence(p.presenceId, { status: PresenceStatus.AWAY, actingUser: "u1" });
    assert.equal(updated.status, PresenceStatus.AWAY);
    assert.equal(updated.advertisement.status, PresenceStatus.AWAY);
    assert.ok(updated.advertisement.version > p.advertisement.version);
  });

  it("rejects a non-user-settable status (e.g. reconnecting/expired)", async () => {
    await assert.rejects(() => ctx.manager.updatePresence(p.presenceId, { status: PresenceStatus.RECONNECTING, actingUser: "u1" }), PresenceValidationError);
    await assert.rejects(() => ctx.manager.updatePresence(p.presenceId, { status: PresenceStatus.EXPIRED, actingUser: "u1" }), PresenceValidationError);
  });

  it("enforces ownership on updates", async () => {
    await assert.rejects(() => ctx.manager.updatePresence(p.presenceId, { status: PresenceStatus.BUSY, actingUser: "intruder" }), UnauthorizedPresenceError);
  });

  it("setDeviceStatus updates by (userId, deviceId)", async () => {
    const updated = await ctx.manager.setDeviceStatus("u1", "d1", PresenceStatus.BUSY, { actingUser: "u1" });
    assert.equal(updated.status, PresenceStatus.BUSY);
  });

  it("emits OFFLINE when a reachable device goes invisible? no — invisible stays reachable", async () => {
    const log = recordEvents(ctx.events);
    await ctx.manager.updatePresence(p.presenceId, { status: PresenceStatus.INVISIBLE, actingUser: "u1" });
    assert.equal(log.ofType(PresenceEventType.OFFLINE).length, 0); // invisible is still reachable
  });

  it("emits OFFLINE when a device signs off", async () => {
    const log = recordEvents(ctx.events);
    const off = await ctx.manager.markOffline(p.presenceId, { actingUser: "u1" });
    assert.equal(off.status, PresenceStatus.OFFLINE);
    assert.equal(log.ofType(PresenceEventType.OFFLINE).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("manager — heartbeat, expiry, recovery", () => {
  let ctx, clock, p;
  beforeEach(async () => {
    clock = makeClock();
    ctx = makePresence({ clock, heartbeatTimeoutMs: 45_000 });
    p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
  });

  it("heartbeat pushes out the expiry window", async () => {
    clock.advance(30_000);
    const beat = await ctx.manager.heartbeat(p.presenceId, { actingUser: "u1" });
    assert.equal(new Date(beat.expiresAt).getTime(), clock() + 45_000);
    assert.equal(beat.status, PresenceStatus.ONLINE);
    assert.equal(beat.missedHeartbeats, 0);
  });

  it("heartbeat emits HEARTBEAT_RECEIVED without spamming status history", async () => {
    const log = recordEvents(ctx.events);
    await ctx.manager.heartbeat(p.presenceId);
    await ctx.manager.heartbeat(p.presenceId);
    assert.equal(log.ofType(PresenceEventType.HEARTBEAT_RECEIVED).length, 2);
    const rec = await ctx.manager.getPresence(p.presenceId, { includeHistory: true });
    // Two identical-status heartbeats add no history entries beyond the initial register.
    assert.equal(rec.statusHistory.length, 1);
  });

  it("a missed heartbeat expires the device via sweep + emits HEARTBEAT_MISSED + EXPIRED", async () => {
    const log = recordEvents(ctx.events);
    clock.advance(46_000);
    const { expired } = await ctx.manager.sweepExpired();
    assert.equal(expired, 1);
    assert.equal(log.ofType(PresenceEventType.HEARTBEAT_MISSED).length, 1);
    assert.equal(log.ofType(PresenceEventType.EXPIRED).length, 1);
    assert.equal(log.ofType(PresenceEventType.OFFLINE).length, 1); // derived (reachable → not)
    const rec = await ctx.manager.getPresence(p.presenceId);
    assert.equal(rec.status, PresenceStatus.EXPIRED);
    assert.equal(rec.missedHeartbeats, 1);
  });

  it("lazily expires an overdue device on read (getPresence)", async () => {
    clock.advance(60_000);
    const rec = await ctx.manager.getPresence(p.presenceId, { actingUser: "u1" });
    assert.equal(rec.status, PresenceStatus.EXPIRED);
  });

  it("a heartbeat RECOVERS an expired/disconnected device to online + emits RECOVERED", async () => {
    const log = recordEvents(ctx.events);
    clock.advance(60_000);
    await ctx.manager.sweepExpired(); // → expired
    const recovered = await ctx.manager.heartbeat(p.presenceId, { actingUser: "u1" });
    assert.equal(recovered.status, PresenceStatus.ONLINE);
    assert.equal(log.ofType(PresenceEventType.RECOVERED).length, 1);
    assert.equal(log.ofType(PresenceEventType.ONLINE).length >= 1, true);
  });

  it("markDisconnected → reconnecting → recovery arc", async () => {
    const dc = await ctx.manager.markDisconnected(p.presenceId);
    assert.equal(dc.status, PresenceStatus.DISCONNECTED);
    assert.equal(dc.reachable, false);
    const back = await ctx.manager.heartbeat(p.presenceId);
    assert.equal(back.status, PresenceStatus.ONLINE);
  });
});

// ---------------------------------------------------------------------------
describe("HeartbeatMonitor", () => {
  it("tick sweeps + accumulates stats; start/stop are idempotent", async () => {
    const clock = makeClock();
    const ctx = makePresence({ clock });
    await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    await ctx.manager.registerPresence({ userId: "u2", deviceId: "d1" });
    clock.advance(50_000);
    const res = await ctx.monitor.tick(clock());
    assert.equal(res.expired, 2);
    assert.equal(ctx.monitor.stats().expired, 2);
    assert.equal(ctx.monitor.stats().sweeps, 1);
    ctx.monitor.start();
    ctx.monitor.start(); // idempotent
    assert.equal(ctx.monitor.isRunning, true);
    ctx.monitor.stop();
    ctx.monitor.stop(); // idempotent
    assert.equal(ctx.monitor.isRunning, false);
  });
});

// ---------------------------------------------------------------------------
describe("queries + not-found", () => {
  let ctx;
  beforeEach(() => {
    ctx = makePresence();
  });

  it("getLastSeen + history + countByStatus", async () => {
    const p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    await ctx.manager.updatePresence(p.presenceId, { status: PresenceStatus.AWAY, actingUser: "u1" });
    const ls = await ctx.manager.getLastSeen("u1", "d1");
    assert.equal(ls.status, PresenceStatus.AWAY);
    const hist = await ctx.manager.getHistory(p.presenceId, { actingUser: "u1" });
    assert.ok(hist.length >= 2);
    const counts = await ctx.manager.countByStatus();
    assert.equal(counts.away, 1);
  });

  it("unknown presence id / device throws NotFound", async () => {
    await assert.rejects(() => ctx.manager.getPresence("missing-00000000", {}), PresenceNotFoundError);
    await assert.rejects(() => ctx.manager.getLastSeen("u1", "ghost"), PresenceNotFoundError);
  });

  it("removePresence deletes + emits REMOVED", async () => {
    const log = recordEvents(ctx.events);
    const p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    const { removed } = await ctx.manager.removePresence(p.presenceId, { actingUser: "u1" });
    assert.equal(removed, true);
    assert.equal(log.ofType(PresenceEventType.REMOVED).length, 1);
    await assert.rejects(() => ctx.manager.getPresence(p.presenceId, {}), PresenceNotFoundError);
  });
});
