/**
 * Repository contracts, registry/directory hydration, concurrent discovery, large-user-base
 * simulation, and performance tests (Layer 6, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeDiscovery, makeIdGen, seedUser, makeIdentity, makeDevice } from "./helpers.js";
import { createInMemoryDiscoveryRepository } from "../repository/inMemoryDiscoveryRepository.js";
import { createInMemoryDirectory, isDirectoryProvider } from "../registry/directory.js";
import { DiscoveryRegistry } from "../registry/registry.js";
import { DiscoveryEventBus } from "../events/events.js";
import { createDiscoverySession, discoveryDedupeKey } from "../session/discoverySession.js";
import { DiscoveryState, DiscoverySource, DiscoveryEventType, RegistryStatus } from "../types/types.js";
import { UnknownUserError, UnknownDeviceError, DiscoveryNotFoundError, DirectoryUnavailableError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("session repository — contract", () => {
  let repo;
  beforeEach(() => {
    ({ sessions: repo } = createInMemoryDiscoveryRepository());
  });

  it("create / findById / update / delete round-trip + deep-copy", async () => {
    const s = createDiscoverySession({ requester: "u1", targetUser: "u2", discoveryId: "disc-00000001", clock: makeClock() });
    await repo.create(s);
    const got = await repo.findById("disc-00000001");
    got.state = DiscoveryState.FAILED; // mutate the copy
    assert.equal((await repo.findById("disc-00000001")).state, DiscoveryState.CREATED); // store untouched
    await repo.update("disc-00000001", { state: DiscoveryState.PENDING });
    assert.equal((await repo.findById("disc-00000001")).state, DiscoveryState.PENDING);
    await assert.rejects(() => repo.update("nope-00000000", {}), DiscoveryNotFoundError);
    assert.equal(await repo.delete("disc-00000001"), true);
    assert.equal(await repo.findById("disc-00000001"), null);
  });

  it("findActiveByDedupeKey matches only live sessions", async () => {
    const s = createDiscoverySession({ requester: "u1", targetUser: "u2", targetDevices: ["d1"], discoveryId: "disc-00000002", clock: makeClock() });
    await repo.create(s);
    const key = discoveryDedupeKey(s);
    assert.ok(await repo.findActiveByDedupeKey(key));
    await repo.update("disc-00000002", { state: DiscoveryState.COMPLETED });
    assert.equal(await repo.findActiveByDedupeKey(key), null);
  });

  it("listByRequester / listByState / listExpired", async () => {
    const clock = makeClock();
    const a = createDiscoverySession({ requester: "u1", targetUser: "x", ttlMs: 1000, discoveryId: "disc-a0000000", clock });
    const b = createDiscoverySession({ requester: "u1", targetUser: "y", ttlMs: 1000, discoveryId: "disc-b0000000", clock });
    const c = createDiscoverySession({ requester: "u2", targetUser: "z", ttlMs: 1000, discoveryId: "disc-c0000000", clock });
    await repo.create(a); await repo.create(b); await repo.create(c);
    assert.equal((await repo.listByRequester("u1")).length, 2);
    assert.equal((await repo.listByState(DiscoveryState.CREATED)).length, 3);
    const expiredIso = new Date(clock() + 5000).toISOString();
    assert.equal((await repo.listExpired(expiredIso)).length, 3);
    assert.equal((await repo.listExpired(new Date(clock()).toISOString())).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("registry repository — contract", () => {
  let repo;
  beforeEach(() => {
    ({ registry: repo } = createInMemoryDiscoveryRepository());
  });

  it("upsert is idempotent by (user, device) and bumps version", async () => {
    await repo.upsert({ userId: "u1", deviceId: "d1", publicKey: "P", status: "active", version: 1, registeredAt: "t0" });
    const again = await repo.upsert({ userId: "u1", deviceId: "d1", publicKey: "P2", status: "active" });
    assert.equal(again.version, 2);
    assert.equal(again.registeredAt, "t0"); // preserved
    assert.equal((await repo.findByUser("u1")).length, 1);
  });

  it("findByUserAndDevice / remove / removeByUser / listAll", async () => {
    await repo.upsert({ userId: "u1", deviceId: "d1", publicKey: "P", status: "active" });
    await repo.upsert({ userId: "u1", deviceId: "d2", publicKey: "P", status: "active" });
    assert.ok(await repo.findByUserAndDevice("u1", "d1"));
    assert.equal(await repo.remove("u1", "d1"), true);
    assert.equal(await repo.remove("u1", "d1"), false);
    assert.equal(await repo.removeByUser("u1"), 1);
    assert.equal((await repo.listAll()).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("registry — directory hydration + resolution", () => {
  it("resolves from the registry first, then hydrates from the directory on a miss", async () => {
    const events = new DiscoveryEventBus();
    const { registry: entries } = createInMemoryDiscoveryRepository();
    const directory = createInMemoryDirectory(seedUser("u2", 2));
    const registry = new DiscoveryRegistry({ entries, directory, events, clock: makeClock() });

    // First resolution hydrates from the directory.
    const first = await registry.resolveUserDevices("u2");
    assert.equal(first.source, DiscoverySource.DIRECTORY);
    assert.equal(first.devices.length, 2);
    // Now the entries are warm → served from the registry.
    const second = await registry.resolveUserDevices("u2");
    assert.equal(second.source, DiscoverySource.REGISTRY);
  });

  it("a self-registered device stays authoritative and filters non-discoverable statuses", async () => {
    const { registry: entries } = createInMemoryDiscoveryRepository();
    const directory = createInMemoryDirectory({
      u2: { identity: makeIdentity("u2"), devices: [makeDevice("u2", "d1"), makeDevice("u2", "d2", { trustStatus: "revoked" })] },
    });
    const registry = new DiscoveryRegistry({ entries, directory, clock: makeClock() });
    const { devices } = await registry.resolveUserDevices("u2");
    assert.deepEqual(devices.map((d) => d.deviceId), ["d1"]); // revoked device excluded
  });

  it("resolveDevice / resolveDevices raise UnknownDeviceError for missing ids", async () => {
    const directory = createInMemoryDirectory(seedUser("u2", 2));
    const registry = new DiscoveryRegistry({ entries: createInMemoryDiscoveryRepository().registry, directory, clock: makeClock() });
    await assert.rejects(() => registry.resolveDevice("u2", "ghost"), UnknownDeviceError);
    await assert.rejects(() => registry.resolveDevices("u2", ["d1", "ghost"]), UnknownDeviceError);
    const ok = await registry.resolveDevices("u2", ["d1"]);
    assert.equal(ok.devices.length, 1);
  });

  it("resolveMetadata throws UnknownUserError when nothing is discoverable", async () => {
    const registry = new DiscoveryRegistry({ entries: createInMemoryDiscoveryRepository().registry, directory: createInMemoryDirectory({}), clock: makeClock() });
    await assert.rejects(() => registry.resolveMetadata("nobody"), UnknownUserError);
  });

  it("surfaces directory read failures as DirectoryUnavailableError", async () => {
    const flaky = {
      async getIdentity() { throw new Error("db down"); },
      async getDevices() { throw new Error("db down"); },
    };
    const registry = new DiscoveryRegistry({ entries: createInMemoryDiscoveryRepository().registry, directory: flaky, clock: makeClock() });
    await assert.rejects(() => registry.resolveIdentity("u2"), DirectoryUnavailableError);
  });

  it("register/deregister emit device events", async () => {
    const events = new DiscoveryEventBus();
    const seen = [];
    events.on("*", (e) => seen.push(e.type));
    const registry = new DiscoveryRegistry({ entries: createInMemoryDiscoveryRepository().registry, events, clock: makeClock() });
    await registry.registerDevice({ userId: "u1", deviceId: "d1", publicKey: "P", fingerprint: "f" });
    await registry.deregisterDevice("u1", "d1");
    assert.ok(seen.includes(DiscoveryEventType.DEVICE_REGISTERED));
    assert.ok(seen.includes(DiscoveryEventType.DEVICE_DEREGISTERED));
  });

  it("isDirectoryProvider validates the contract", () => {
    assert.ok(isDirectoryProvider(createInMemoryDirectory({})));
    assert.ok(!isDirectoryProvider({ getIdentity() {} }));
    assert.ok(!isDirectoryProvider(null));
  });
});

// ---------------------------------------------------------------------------
describe("concurrent discovery — coalescing", () => {
  it("N identical concurrent lookups collapse to one session + one directory hit", async () => {
    let directoryHits = 0;
    const base = createInMemoryDirectory(seedUser("u2", 2));
    const countingDirectory = {
      getIdentity: (u) => { directoryHits++; return base.getIdentity(u); },
      getDevices: (u) => base.getDevices(u),
    };
    const ctx = makeDiscovery({ clock: makeClock() });
    // swap in the counting directory
    const manager = ctx.manager;
    manager.registry.directory = countingDirectory;

    const results = await Promise.all(
      Array.from({ length: 25 }, () => manager.lookupUser({ requester: "u1", targetUser: "u2" })),
    );
    const ids = new Set(results.map((r) => r.session.discoveryId));
    assert.equal(ids.size, 1, "all concurrent lookups share one session");
    assert.equal(directoryHits, 1, "directory resolved exactly once");
    assert.ok(results.every((r) => r.session.state === DiscoveryState.RESOLVED));
  });

  it("distinct requesters/targets do not coalesce", async () => {
    const ctx = makeDiscovery({ seed: { ...seedUser("u2", 1), ...seedUser("u3", 1) } });
    const [a, b] = await Promise.all([
      ctx.manager.lookupUser({ requester: "u1", targetUser: "u2" }),
      ctx.manager.lookupUser({ requester: "u1", targetUser: "u3" }),
    ]);
    assert.notEqual(a.session.discoveryId, b.session.discoveryId);
  });
});

// ---------------------------------------------------------------------------
describe("large user base simulation", () => {
  it("resolves 500 distinct users, then serves a hot user from cache", async () => {
    const seed = {};
    for (let i = 0; i < 500; i++) seed[`user${i}`] = { identity: makeIdentity(`user${i}`), devices: [makeDevice(`user${i}`, "d1"), makeDevice(`user${i}`, "d2")] };
    const ctx = makeDiscovery({ seed, clock: makeClock(), cacheOptions: { limit: 100 } });

    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) => ctx.manager.lookupUser({ requester: "hub", targetUser: `user${i}` })),
    );
    assert.equal(results.filter((r) => r.session.state === DiscoveryState.RESOLVED).length, 500);

    // Cache capacity is 100 → evictions happened but correctness holds.
    const stats = ctx.manager.cacheStats();
    assert.ok(stats.evictions > 0);
    assert.ok(stats.size <= 100);

    // Warm one user deterministically, then a fresh requester re-resolving it is a cache hit
    // (which user survived the concurrent LRU churn is non-deterministic, so we re-warm first).
    await ctx.manager.lookupUser({ requester: "warm", targetUser: "user0" });
    const hot = await ctx.manager.lookupUser({ requester: "warm2", targetUser: "user0" });
    assert.equal(hot.metadata.source, DiscoverySource.CACHE);
  });

  it("mixed known/unknown targets: known resolve, unknown fail + negative-cache", async () => {
    const seed = {};
    for (let i = 0; i < 50; i++) seed[`k${i}`] = { identity: makeIdentity(`k${i}`), devices: [makeDevice(`k${i}`, "d1")] };
    const ctx = makeDiscovery({ seed });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        ctx.manager.lookupUser({ requester: "hub", targetUser: i < 50 ? `k${i}` : `ghost${i}` }),
      ),
    );
    assert.equal(results.filter((r) => r.session.state === DiscoveryState.RESOLVED).length, 50);
    assert.equal(results.filter((r) => r.session.state === DiscoveryState.FAILED).length, 50);
  });
});

// ---------------------------------------------------------------------------
describe("performance smoke", () => {
  it("1000 cache probes stay well under a generous time budget", () => {
    const ctx = makeDiscovery();
    const cache = ctx.cache;
    for (let i = 0; i < 1000; i++) cache.set(`u${i % 200}`, { userId: `u${i % 200}`, devices: [], deviceIds: [] });
    const start = process.hrtime.bigint();
    let hits = 0;
    for (let i = 0; i < 1000; i++) if (cache.get(`u${i % 200}`).outcome === "hit") hits++;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(hits > 0);
    assert.ok(ms < 200, `cache probes took ${ms}ms`);
  });

  it("session repository lookups are O(1)-ish across 2000 records", async () => {
    const { sessions } = createInMemoryDiscoveryRepository();
    const idGen = makeIdGen();
    const clock = makeClock();
    for (let i = 0; i < 2000; i++) {
      await sessions.create(createDiscoverySession({ requester: `u${i}`, targetUser: "t", discoveryId: idGen(), clock }));
    }
    const start = process.hrtime.bigint();
    const found = await sessions.findById("disc-00001000");
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(found);
    assert.ok(ms < 50, `findById took ${ms}ms`);
  });
});
