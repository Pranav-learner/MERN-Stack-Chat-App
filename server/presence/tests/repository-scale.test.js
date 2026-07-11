/**
 * Presence repository contract, concurrency, multi-device, large-scale online-users, stress,
 * and performance tests (Layer 6, Sprint 2). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makePresence, makeClock, makeIdGen } from "./helpers.js";
import { createInMemoryPresenceRepository } from "../repository/inMemoryPresenceRepository.js";
import { createPresenceRecord } from "../record/presenceRecord.js";
import { PresenceStatus } from "../types/types.js";
import { PresenceNotFoundError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("presence repository — contract", () => {
  let repo;
  beforeEach(() => {
    ({ presence: repo } = createInMemoryPresenceRepository());
  });

  // A shared monotonic id generator so every rec() gets a DISTINCT presenceId.
  let idGen;
  beforeEach(() => {
    idGen = makeIdGen("rec");
  });
  const rec = (userId, deviceId, over = {}) =>
    createPresenceRecord({ userId, deviceId, clock: makeClock(), idGenerator: idGen, ...over });

  it("create / findById / findByUserAndDevice / update / delete + deep-copy", async () => {
    const r = rec("u1", "d1");
    await repo.create(r);
    const got = await repo.findById(r.presenceId);
    got.status = PresenceStatus.OFFLINE; // mutate the copy
    assert.equal((await repo.findById(r.presenceId)).status, PresenceStatus.ONLINE); // store untouched
    assert.equal((await repo.findByUserAndDevice("u1", "d1")).presenceId, r.presenceId);
    await repo.update(r.presenceId, { status: PresenceStatus.AWAY });
    assert.equal((await repo.findById(r.presenceId)).status, PresenceStatus.AWAY);
    await assert.rejects(() => repo.update("missing-00000000", {}), PresenceNotFoundError);
    assert.equal(await repo.delete(r.presenceId), true);
    assert.equal(await repo.findByUserAndDevice("u1", "d1"), null);
  });

  it("upsert replaces a stale record for the same device (new presenceId)", async () => {
    const a = rec("u1", "d1");
    await repo.upsert(a);
    const b = rec("u1", "d1"); // different presenceId, same device
    await repo.upsert(b);
    assert.equal(await repo.findById(a.presenceId), null); // stale dropped
    assert.equal((await repo.findByUserAndDevice("u1", "d1")).presenceId, b.presenceId);
    assert.equal((await repo.findByUser("u1")).length, 1);
  });

  it("listByStatus / listReachableByUser / listExpired / countByStatus", async () => {
    const clock = makeClock();
    await repo.create(createPresenceRecord({ userId: "u1", deviceId: "d1", status: PresenceStatus.ONLINE, timeoutMs: 1000, clock, idGenerator: makeIdGen("a") }));
    await repo.create(createPresenceRecord({ userId: "u1", deviceId: "d2", status: PresenceStatus.INVISIBLE, timeoutMs: 1000, clock, idGenerator: makeIdGen("b") }));
    await repo.create(createPresenceRecord({ userId: "u2", deviceId: "d1", status: PresenceStatus.OFFLINE, timeoutMs: 1000, clock, idGenerator: makeIdGen("c") }));

    assert.equal((await repo.listByStatus(PresenceStatus.ONLINE)).length, 1);
    assert.equal((await repo.listReachableByUser("u1")).length, 2); // online + invisible both reachable
    assert.equal((await repo.listExpired(new Date(clock() + 5000).toISOString())).length, 2); // only reachable ones are sweepable (offline excluded)
    const counts = await repo.countByStatus();
    assert.equal(counts.online, 1);
    assert.equal(counts.offline, 1);
  });

  it("listExpired excludes offline/expired (non-sweepable) records", async () => {
    const clock = makeClock();
    await repo.create(createPresenceRecord({ userId: "u1", deviceId: "d1", status: PresenceStatus.OFFLINE, timeoutMs: 1000, clock, idGenerator: makeIdGen("a") }));
    const stale = await repo.listExpired(new Date(clock() + 100000).toISOString());
    assert.equal(stale.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("concurrent updates", () => {
  it("many concurrent heartbeats on one device converge to a single fresh record", async () => {
    const clock = makeClock();
    const ctx = makePresence({ clock });
    const p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    clock.advance(10_000);
    await Promise.all(Array.from({ length: 30 }, () => ctx.manager.heartbeat(p.presenceId)));
    const rec = await ctx.manager.getPresence(p.presenceId);
    assert.equal(rec.status, PresenceStatus.ONLINE);
    assert.equal(new Date(rec.expiresAt).getTime(), clock() + 45_000);
  });

  it("concurrent registrations of DISTINCT devices for one user all persist", async () => {
    const ctx = makePresence();
    await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.manager.registerPresence({ userId: "u1", deviceId: `d${i}` })));
    const devices = await ctx.manager.listUserDevices("u1");
    assert.equal(devices.length, 20);
  });

  it("concurrent sweep + heartbeat is safe (idempotent expiry)", async () => {
    const clock = makeClock();
    const ctx = makePresence({ clock });
    const p = await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    clock.advance(50_000);
    // Race a sweep against a recovering heartbeat; neither should throw + final state is coherent.
    await Promise.all([ctx.manager.sweepExpired(), ctx.manager.heartbeat(p.presenceId).catch(() => {})]);
    const rec = await ctx.manager.getPresence(p.presenceId);
    assert.ok([PresenceStatus.ONLINE, PresenceStatus.EXPIRED].includes(rec.status));
  });
});

// ---------------------------------------------------------------------------
describe("large-scale online users", () => {
  it("registers 1000 users × 2 devices and reports accurate reachability", async () => {
    const ctx = makePresence({ cacheOptions: { limit: 500 } });
    const jobs = [];
    for (let u = 0; u < 1000; u++) {
      jobs.push(ctx.manager.registerPresence({ userId: `user${u}`, deviceId: "d1" }));
      jobs.push(ctx.manager.registerPresence({ userId: `user${u}`, deviceId: "d2", status: PresenceStatus.AWAY }));
    }
    await Promise.all(jobs);
    const counts = await ctx.manager.countByStatus();
    assert.equal(counts.online, 1000);
    assert.equal(counts.away, 1000);

    // A resolve for a specific user returns exactly their 2 reachable devices.
    const one = await ctx.manager.resolveActiveDevices("user777");
    assert.equal(one.devices.length, 2);

    // Cache is bounded (limit 500) but correctness holds under eviction.
    for (let u = 0; u < 1000; u++) await ctx.manager.resolveActiveDevices(`user${u}`);
    assert.ok(ctx.manager.cacheStats().evictions > 0);
    assert.ok(ctx.manager.cacheStats().size <= 500);
  });

  it("mass expiry: 500 idle devices are all swept in one pass", async () => {
    const clock = makeClock();
    const ctx = makePresence({ clock });
    for (let u = 0; u < 500; u++) await ctx.manager.registerPresence({ userId: `u${u}`, deviceId: "d1" });
    clock.advance(60_000);
    const { expired } = await ctx.manager.sweepExpired();
    assert.equal(expired, 500);
    assert.equal((await ctx.manager.countByStatus()).expired, 500);
  });
});

// ---------------------------------------------------------------------------
describe("stress + performance smoke", () => {
  it("mixed register/heartbeat/update/offline churn stays consistent", async () => {
    const clock = makeClock();
    const ctx = makePresence({ clock });
    // Register 100 devices.
    const ps = [];
    for (let i = 0; i < 100; i++) ps.push(await ctx.manager.registerPresence({ userId: `u${i % 25}`, deviceId: `d${i}` }));
    // Churn: heartbeat evens, set-away odds, offline every 10th.
    clock.advance(5000);
    await Promise.all(
      ps.map((p, i) => {
        if (i % 10 === 0) return ctx.manager.markOffline(p.presenceId).catch(() => {});
        if (i % 2 === 0) return ctx.manager.heartbeat(p.presenceId);
        return ctx.manager.updatePresence(p.presenceId, { status: PresenceStatus.AWAY, actingUser: p.userId });
      }),
    );
    const counts = await ctx.manager.countByStatus();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 100); // no records lost or duplicated
    assert.equal(counts.offline, 10);
  });

  it("1000 cache probes stay well under a generous budget", () => {
    const ctx = makePresence();
    for (let i = 0; i < 1000; i++) ctx.cache.set(`u${i % 200}`, [{ deviceId: "d1" }]);
    const start = process.hrtime.bigint();
    let hits = 0;
    for (let i = 0; i < 1000; i++) if (ctx.cache.get(`u${i % 200}`).outcome === "hit") hits++;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(hits > 0);
    assert.ok(ms < 200, `cache probes took ${ms}ms`);
  });

  it("repository device lookup is O(1)-ish across 3000 records", async () => {
    const { presence } = createInMemoryPresenceRepository();
    const clock = makeClock();
    for (let i = 0; i < 3000; i++) {
      await presence.create(createPresenceRecord({ userId: `u${i}`, deviceId: "d1", clock, idGenerator: makeIdGen(`k${i}`) }));
    }
    const start = process.hrtime.bigint();
    const found = await presence.findByUserAndDevice("u1500", "d1");
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(found);
    assert.ok(ms < 50, `findByUserAndDevice took ${ms}ms`);
  });
});
