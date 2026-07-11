/**
 * Presence caching, validation, serializers, API facade, and service-layer tests
 * (Layer 6, Sprint 2). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makePresence, makeClock, makeIdentity, recordEvents } from "./helpers.js";
import { PresenceCache, PresenceCacheOutcome } from "../cache/cache.js";
import { createPresenceApi } from "../api/presenceApi.js";
import { createPresenceService } from "../services/presenceService.js";
import {
  validatePresenceId,
  validateUserRef,
  validateDeviceRef,
  validateStatus,
  validateUserSettableStatus,
  validateRegistrationRequest,
  assertNotExpired,
  assertOwner,
  assertNoDuplicateRegistration,
  assertNoSecretMaterial,
  validateAdvertisement,
  validatePresenceRecord,
  validatePresenceRepository,
  requirePresence,
  FORBIDDEN_SECRET_KEYS,
} from "../validators/validators.js";
import {
  toPublicPresence,
  toPublicAdvertisement,
  toPresenceStatus,
  toLastSeen,
} from "../serializers/serializer.js";
import { createPresenceRecord } from "../record/presenceRecord.js";
import { createDeviceAdvertisement } from "../advertisement/advertisement.js";
import { PresenceStatus, PresenceSource, PresenceEventType } from "../types/types.js";
import {
  PresenceValidationError,
  PresenceNotFoundError,
  PresenceExpiredError,
  UnauthorizedPresenceError,
  DuplicatePresenceError,
  CorruptedPresenceError,
} from "../errors.js";

// ---------------------------------------------------------------------------
describe("cache — TTL, negative, invalidation, capacity", () => {
  let clock, cache;
  beforeEach(() => {
    clock = makeClock();
    cache = new PresenceCache({ clock, ttlMs: 1000, negativeTtlMs: 200, limit: 3 });
  });

  it("miss → set → hit → expire", () => {
    assert.equal(cache.get("u1").outcome, PresenceCacheOutcome.MISS);
    cache.set("u1", [{ deviceId: "d1" }]);
    assert.equal(cache.get("u1").outcome, PresenceCacheOutcome.HIT);
    clock.advance(1000);
    assert.equal(cache.get("u1").outcome, PresenceCacheOutcome.EXPIRED);
    assert.equal(cache.get("u1").outcome, PresenceCacheOutcome.MISS);
  });

  it("negative cache with a shorter TTL", () => {
    cache.setNegative("u2");
    assert.equal(cache.get("u2").outcome, PresenceCacheOutcome.NEGATIVE);
    clock.advance(200);
    assert.equal(cache.get("u2").outcome, PresenceCacheOutcome.EXPIRED);
  });

  it("invalidateUser + pruneExpired + stats", () => {
    cache.set("a", [1]);
    cache.set("b", [2]);
    assert.equal(cache.invalidateUser("a"), true);
    assert.equal(cache.invalidateUser("a"), false);
    clock.advance(1000);
    assert.equal(cache.pruneExpired(), 1);
    cache.set("c", [3]);
    cache.get("c"); // hit
    cache.get("z"); // miss
    const stats = cache.stats();
    assert.ok(stats.hitRate > 0 && stats.hitRate < 1);
  });

  it("LRU eviction beyond capacity, promoting on access", () => {
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]);
    cache.get("a"); // promote a
    const { evicted } = cache.set("d", [4]); // evict LRU (b)
    assert.equal(evicted, "b");
    assert.equal(cache.get("b").outcome, PresenceCacheOutcome.MISS);
    assert.equal(cache.get("a").outcome, PresenceCacheOutcome.HIT);
  });
});

// ---------------------------------------------------------------------------
describe("cache — manager integration + auto-invalidation", () => {
  it("second resolve is a cache hit; a presence write invalidates it", async () => {
    const ctx = makePresence();
    await ctx.manager.registerPresence({ userId: "u1", deviceId: "d1" });
    const first = await ctx.manager.resolveActiveDevices("u1");
    assert.equal(first.source, PresenceSource.REPOSITORY);
    const second = await ctx.manager.resolveActiveDevices("u1");
    assert.equal(second.source, PresenceSource.CACHE);

    const log = recordEvents(ctx.events);
    await ctx.manager.registerPresence({ userId: "u1", deviceId: "d2" }); // write → invalidate
    assert.ok(log.ofType(PresenceEventType.CACHE_INVALIDATED).length >= 1);
    const third = await ctx.manager.resolveActiveDevices("u1");
    assert.equal(third.source, PresenceSource.REPOSITORY);
    assert.equal(third.devices.length, 2);
  });

  it("negative-caches a user with no reachable devices", async () => {
    const ctx = makePresence();
    const first = await ctx.manager.resolveActiveDevices("ghost");
    assert.equal(first.devices.length, 0);
    assert.equal(first.source, PresenceSource.REPOSITORY);
    const second = await ctx.manager.resolveActiveDevices("ghost");
    assert.equal(second.source, PresenceSource.NEGATIVE_CACHE);
  });
});

// ---------------------------------------------------------------------------
describe("validators — shapes + guards", () => {
  it("id / user / device / status guards", () => {
    assert.equal(validatePresenceId("abcd1234ef"), "abcd1234ef");
    assert.throws(() => validatePresenceId("short"), PresenceValidationError);
    assert.equal(validateUserRef("user_1"), "user_1");
    assert.throws(() => validateUserRef("bad id!"), PresenceValidationError);
    assert.equal(validateDeviceRef("dev.1:2-3"), "dev.1:2-3");
    assert.equal(validateStatus(PresenceStatus.ONLINE), PresenceStatus.ONLINE);
    assert.throws(() => validateStatus("nope"), PresenceValidationError);
    assert.equal(validateUserSettableStatus(PresenceStatus.BUSY), PresenceStatus.BUSY);
    assert.throws(() => validateUserSettableStatus(PresenceStatus.EXPIRED), PresenceValidationError);
  });

  it("validateRegistrationRequest catches malformed requests", () => {
    assert.throws(() => validateRegistrationRequest(null), PresenceValidationError);
    assert.throws(() => validateRegistrationRequest({ userId: "u1" }), PresenceValidationError); // no deviceId
    assert.throws(() => validateRegistrationRequest({ userId: "u1", deviceId: "d1", timeoutMs: -1 }), PresenceValidationError);
    assert.throws(() => validateRegistrationRequest({ userId: "u1", deviceId: "d1", metadata: [1, 2] }), PresenceValidationError);
    assert.throws(() => validateRegistrationRequest({ userId: "u1", deviceId: "d1", status: "bogus" }), PresenceValidationError);
    assert.doesNotThrow(() => validateRegistrationRequest({ userId: "u1", deviceId: "d1", status: "online" }));
  });

  it("expired / owner / duplicate / not-found guards", () => {
    const clock = makeClock();
    const r = createPresenceRecord({ userId: "u1", deviceId: "d1", timeoutMs: 1000, clock });
    assert.doesNotThrow(() => assertNotExpired(r, clock()));
    assert.throws(() => assertNotExpired(r, clock() + 2000), PresenceExpiredError);
    assert.doesNotThrow(() => assertOwner(r, "u1"));
    assert.throws(() => assertOwner(r, "other"), UnauthorizedPresenceError);
    assert.throws(() => assertNoDuplicateRegistration(r, true), DuplicatePresenceError);
    assert.doesNotThrow(() => assertNoDuplicateRegistration(r, false)); // non-reachable existing → revive ok
    assert.doesNotThrow(() => assertNoDuplicateRegistration(null, false));
    assert.throws(() => requirePresence(null, "x"), PresenceNotFoundError);
  });

  it("repository contract validator", () => {
    assert.throws(() => validatePresenceRepository({}), PresenceValidationError);
    assert.throws(() => validatePresenceRepository({ upsert() {} }), PresenceValidationError);
  });
});

// ---------------------------------------------------------------------------
describe("validators — no-secret invariant", () => {
  for (const secret of FORBIDDEN_SECRET_KEYS) {
    it(`rejects a record carrying "${secret}"`, () => {
      assert.throws(() => assertNoSecretMaterial({ userId: "u", [secret]: "leak" }), CorruptedPresenceError);
    });
  }

  it("scans nested + array structures and tolerates cycles", () => {
    assert.throws(() => assertNoSecretMaterial({ a: { b: [{ sessionKey: "x" }] } }), CorruptedPresenceError);
    assert.doesNotThrow(() => assertNoSecretMaterial({ a: { b: [{ publicKey: "ok" }] } }));
    const node = { userId: "u" };
    node.self = node;
    assert.doesNotThrow(() => assertNoSecretMaterial(node));
  });

  it("validateAdvertisement + validatePresenceRecord catch corruption", () => {
    assert.throws(() => validateAdvertisement({ userId: "u" }), CorruptedPresenceError);
    assert.throws(() => validateAdvertisement({ userId: "u", deviceId: "d", status: "weird" }), CorruptedPresenceError);
    const good = createDeviceAdvertisement({ userId: "u", deviceId: "d", status: "online" });
    assert.doesNotThrow(() => validateAdvertisement(good));
    assert.throws(() => validatePresenceRecord({ presenceId: "x" }), CorruptedPresenceError);
  });
});

// ---------------------------------------------------------------------------
describe("serializers — public DTOs", () => {
  it("presence DTO exposes flags + strips history unless requested", () => {
    const clock = makeClock();
    const r = createPresenceRecord({ userId: "u1", deviceId: "d1", identity: makeIdentity("u1"), clock });
    const dto = toPublicPresence(r);
    assert.equal(dto.reachable, true);
    assert.equal(dto.online, true);
    assert.equal(dto.statusHistory, undefined);
    assert.equal(toPublicPresence(r, { includeHistory: true }).statusHistory.length, 1);
    assert.equal(toPublicPresence(null), null);
  });

  it("advertisement DTO surfaces public identity + inert placeholders", () => {
    const ad = toPublicAdvertisement(createDeviceAdvertisement({ userId: "u", deviceId: "d", identity: makeIdentity("u"), status: "online" }));
    assert.equal(ad.publicIdentity.publicKey, "IDPUB-u-1");
    assert.equal(ad.transport.enabled, false);
    assert.equal(toPublicAdvertisement(null), null);
  });

  it("status + last-seen compact views", () => {
    const clock = makeClock();
    const r = createPresenceRecord({ userId: "u1", deviceId: "d1", status: "invisible", clock });
    assert.equal(toPresenceStatus(r).reachable, true);
    assert.equal(toPresenceStatus(r).online, false); // invisible not visible-online
    assert.equal(toLastSeen(r).status, "invisible");
  });
});

// ---------------------------------------------------------------------------
describe("API facade", () => {
  let ctx, api;
  beforeEach(() => {
    ctx = makePresence();
    api = createPresenceApi(ctx.manager);
  });

  it("requires an actingUser", async () => {
    await assert.rejects(() => api.register({ deviceId: "d1" }), /actingUser is required/);
  });

  it("register → heartbeat → listOnline → goOffline round-trips", async () => {
    const p = await api.register({ actingUser: "u1", deviceId: "d1", status: "online" });
    await api.heartbeat({ actingUser: "u1", presenceId: p.presenceId });
    const online = await api.listOnline({ actingUser: "viewer", userId: "u1" });
    assert.equal(online.length, 1);
    const off = await api.goOffline({ actingUser: "u1", presenceId: p.presenceId });
    assert.equal(off.status, PresenceStatus.OFFLINE);
  });

  it("lookup resolves reachable devices; lastSeen + history work", async () => {
    await api.register({ actingUser: "u1", deviceId: "d1" });
    const lk = await api.lookup({ actingUser: "viewer", userId: "u1" });
    assert.equal(lk.devices.length, 1);
    const ls = await api.lastSeen({ actingUser: "viewer", userId: "u1", deviceId: "d1" });
    assert.equal(ls.reachable, true);
  });

  it("exposes the manager", () => {
    assert.equal(api.manager, ctx.manager);
  });
});

// ---------------------------------------------------------------------------
describe("presence service (socket-oriented)", () => {
  let ctx, service;
  beforeEach(() => {
    ctx = makePresence();
    service = createPresenceService({ manager: ctx.manager });
  });

  it("onConnect registers; a second connect is treated as a heartbeat (no duplicate)", async () => {
    const first = await service.onConnect({ userId: "u1", deviceId: "d1", identity: makeIdentity("u1") });
    assert.equal(first.status, PresenceStatus.ONLINE);
    const again = await service.onConnect({ userId: "u1", deviceId: "d1" }); // reconnect, no throw
    assert.equal(again.presenceId, first.presenceId);
    assert.equal(again.status, PresenceStatus.ONLINE);
  });

  it("onHeartbeat + onDisconnect drive the lifecycle", async () => {
    const p = await service.onConnect({ userId: "u1", deviceId: "d1" });
    const beat = await service.onHeartbeat({ userId: "u1", deviceId: "d1" });
    assert.equal(beat.presenceId, p.presenceId);
    const dc = await service.onDisconnect({ userId: "u1", deviceId: "d1" });
    assert.equal(dc.status, PresenceStatus.DISCONNECTED);
    assert.equal(await service.onDisconnect({ userId: "u1", deviceId: "ghost" }), null);
  });

  it("summaryFor reports reachable + visible-online split", async () => {
    await service.onConnect({ userId: "u1", deviceId: "d1" });
    await service.onConnect({ userId: "u1", deviceId: "d2" });
    await ctx.manager.setDeviceStatus("u1", "d2", PresenceStatus.INVISIBLE, { actingUser: "u1" });
    const s = await service.summaryFor("u1");
    assert.equal(s.reachable.length, 2); // both reachable
    assert.equal(s.online.length, 1); // only d1 visible-online
  });
});
