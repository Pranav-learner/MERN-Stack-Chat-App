/**
 * Caching, expiration, validation, metadata, and serializer tests (Layer 6, Sprint 1).
 * DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeDiscovery, seedUser } from "./helpers.js";
import { DiscoveryCache, cacheKey } from "../cache/cache.js";
import {
  createDiscoveryMetadata,
  createDeviceDescriptor,
  createIdentityDescriptor,
  createPresencePlaceholder,
  createCapabilityPlaceholder,
  createTransportPlaceholder,
  createCapabilitiesSnapshot,
  appendAudit,
  createAuditEntry,
} from "../metadata/metadata.js";
import {
  validateDiscoveryId,
  validateUserRef,
  validateDeviceRef,
  validateLookupType,
  validateLookupRequest,
  assertNotExpired,
  assertRequester,
  assertNoDuplicateDiscovery,
  assertNoSecretMaterial,
  validateDiscoveryMetadata,
  validateDiscoverySession,
  validateSessionRepository,
  validateRegistryRepository,
  requireDiscoverySession,
  FORBIDDEN_SECRET_KEYS,
} from "../validators/validators.js";
import {
  toPublicDiscoverySession,
  toPublicDiscoveryMetadata,
  toPublicDeviceDescriptor,
  toDiscoveryStatus,
} from "../serializers/serializer.js";
import { createDiscoverySession } from "../session/discoverySession.js";
import {
  DiscoveryState,
  LookupType,
  DiscoverySource,
  CacheOutcome,
  RegistryStatus,
} from "../types/types.js";
import {
  DiscoveryValidationError,
  DiscoveryNotFoundError,
  DiscoveryExpiredError,
  UnauthorizedDiscoveryError,
  DuplicateDiscoveryError,
  CorruptedDiscoveryMetadataError,
} from "../errors.js";

// ---------------------------------------------------------------------------
describe("cache — TTL, negative, invalidation, capacity", () => {
  let clock, cache;
  const meta = (userId) => createDiscoveryMetadata({ userId, devices: [], source: DiscoverySource.REGISTRY });

  beforeEach(() => {
    clock = makeClock();
    cache = new DiscoveryCache({ clock, ttlMs: 1000, negativeTtlMs: 200, limit: 3 });
  });

  it("miss → set → hit → expire", () => {
    assert.equal(cache.get("u1").outcome, CacheOutcome.MISS);
    cache.set("u1", meta("u1"));
    const hit = cache.get("u1");
    assert.equal(hit.outcome, CacheOutcome.HIT);
    assert.equal(hit.value.userId, "u1");
    clock.advance(1000);
    assert.equal(cache.get("u1").outcome, CacheOutcome.EXPIRED);
    assert.equal(cache.get("u1").outcome, CacheOutcome.MISS); // pruned by the expired probe
  });

  it("negative cache with its own (shorter) TTL", () => {
    cache.setNegative("ghost");
    assert.equal(cache.get("ghost").outcome, CacheOutcome.NEGATIVE);
    clock.advance(200);
    assert.equal(cache.get("ghost").outcome, CacheOutcome.EXPIRED);
  });

  it("device-subset keys are cached independently of the all-devices key", () => {
    cache.set("u1", meta("u1")); // all
    cache.set("u1", meta("u1"), ["d1"]); // subset
    assert.notEqual(cacheKey("u1"), cacheKey("u1", ["d1"]));
    assert.equal(cache.get("u1", ["d1"]).outcome, CacheOutcome.HIT);
  });

  it("invalidateUser drops every key for a user (positive + negative)", () => {
    cache.set("u1", meta("u1"));
    cache.set("u1", meta("u1"), ["d1"]);
    cache.setNegative("u1", ["gone"]);
    assert.equal(cache.invalidateUser("u1"), 3);
    assert.equal(cache.get("u1").outcome, CacheOutcome.MISS);
  });

  it("invalidate removes a single key; refresh = set again", () => {
    cache.set("u1", meta("u1"), ["d1"]);
    assert.equal(cache.invalidate("u1", ["d1"]), true);
    assert.equal(cache.invalidate("u1", ["d1"]), false);
  });

  it("LRU eviction beyond capacity, promoting on access", () => {
    cache.set("a", meta("a"));
    cache.set("b", meta("b"));
    cache.set("c", meta("c"));
    cache.get("a"); // promote a → MRU
    const { evicted } = cache.set("d", meta("d")); // over capacity of 3 → evict LRU (b)
    assert.equal(evicted, "b");
    assert.equal(cache.get("b").outcome, CacheOutcome.MISS);
    assert.equal(cache.get("a").outcome, CacheOutcome.HIT);
  });

  it("pruneExpired sweeps stale entries and stats reflect hit rate", () => {
    cache.set("a", meta("a"));
    cache.set("b", meta("b"));
    clock.advance(1000);
    assert.equal(cache.pruneExpired(), 2);
    cache.set("c", meta("c"));
    cache.get("c"); // hit
    cache.get("z"); // miss
    const stats = cache.stats();
    assert.equal(stats.size, 1);
    assert.ok(stats.hitRate > 0 && stats.hitRate < 1);
  });
});

// ---------------------------------------------------------------------------
describe("cache — integration with manager", () => {
  it("second lookup is served from cache; register invalidates", async () => {
    const clock = makeClock();
    const ctx = makeDiscovery({ seed: seedUser("u2", 2), clock });
    const first = await ctx.manager.lookupUser({ requester: "a", targetUser: "u2" });
    assert.equal(first.metadata.source, DiscoverySource.DIRECTORY);
    const second = await ctx.manager.lookupUser({ requester: "b", targetUser: "u2" });
    assert.equal(second.metadata.source, DiscoverySource.CACHE);
    assert.equal(ctx.manager.cacheStats().hits, 1);
  });
});

// ---------------------------------------------------------------------------
describe("metadata builders + placeholders", () => {
  it("device descriptor whitelists public fields + inert placeholders", () => {
    const d = createDeviceDescriptor({ userId: "u1", deviceId: "d1", publicKey: "PUB", fingerprint: "fp" });
    assert.equal(d.status, RegistryStatus.ACTIVE);
    assert.equal(d.presence.reserved, true);
    assert.equal(d.presence.enabled, false);
    assert.equal(d.capabilities.enabled, false);
    assert.equal(d.transport.enabled, false);
  });

  it("normalizes trust statuses onto registry discoverability", () => {
    assert.equal(createDeviceDescriptor({ userId: "u", deviceId: "d", publicKey: "P", trustStatus: "revoked" }).status, RegistryStatus.REVOKED);
    assert.equal(createDeviceDescriptor({ userId: "u", deviceId: "d", publicKey: "P", trustStatus: "pending" }).status, RegistryStatus.INACTIVE);
    assert.equal(createDeviceDescriptor({ userId: "u", deviceId: "d", publicKey: "P", trustStatus: "trusted" }).status, RegistryStatus.ACTIVE);
  });

  it("identity descriptor carries only public fields; null-safe", () => {
    assert.equal(createIdentityDescriptor(null), null);
    const id = createIdentityDescriptor({ identityId: "id1", publicKey: "PUB", fingerprint: "fp" });
    assert.equal(id.algorithm, "ed25519");
    assert.equal(id.version, 1);
  });

  it("discovery metadata assembles identity + devices with matching id list", () => {
    const devices = [createDeviceDescriptor({ userId: "u", deviceId: "d1", publicKey: "P1" }), createDeviceDescriptor({ userId: "u", deviceId: "d2", publicKey: "P2" })];
    const m = createDiscoveryMetadata({ userId: "u", identity: createIdentityDescriptor({ identityId: "i", publicKey: "IP" }), devices });
    assert.deepEqual(m.deviceIds, ["d1", "d2"]);
    assert.equal(m.schemaVersion, 1);
  });

  it("all placeholders are inert + reserved", () => {
    for (const p of [createPresencePlaceholder(), createCapabilityPlaceholder(), createTransportPlaceholder()]) {
      assert.equal(p.enabled, false);
      assert.equal(p.reserved, true);
    }
    const snap = createCapabilitiesSnapshot();
    assert.equal(snap.presenceAvailable, false);
    assert.equal(snap.natTraversal, false);
  });

  it("appendAudit is immutable + capped", () => {
    let audit = [];
    for (let i = 0; i < 120; i++) audit = appendAudit(audit, createAuditEntry("tick", { at: `t${i}` }), 100);
    assert.equal(audit.length, 100);
    assert.equal(audit[audit.length - 1].at, "t119");
  });
});

// ---------------------------------------------------------------------------
describe("validators — request + reference shapes", () => {
  it("id / user / device / lookup-type shape guards", () => {
    assert.equal(validateDiscoveryId("abcd1234ef"), "abcd1234ef");
    assert.throws(() => validateDiscoveryId("short"), DiscoveryValidationError);
    assert.equal(validateUserRef("user_1"), "user_1");
    assert.throws(() => validateUserRef("bad id!"), DiscoveryValidationError);
    assert.equal(validateDeviceRef("dev.1:2-3"), "dev.1:2-3");
    assert.throws(() => validateDeviceRef(""), DiscoveryValidationError);
    assert.equal(validateLookupType(LookupType.USER), LookupType.USER);
    assert.throws(() => validateLookupType("nope"), DiscoveryValidationError);
  });

  it("validateLookupRequest catches malformed requests", () => {
    assert.throws(() => validateLookupRequest(null), DiscoveryValidationError);
    assert.throws(() => validateLookupRequest({ requester: "u1" }), DiscoveryValidationError); // no targetUser
    assert.throws(() => validateLookupRequest({ requester: "u1", targetUser: "u2", targetDevices: "d1" }), DiscoveryValidationError);
    assert.throws(() => validateLookupRequest({ requester: "u1", targetUser: "u2", ttlMs: -5 }), DiscoveryValidationError);
    assert.doesNotThrow(() => validateLookupRequest({ requester: "u1", targetUser: "u2", targetDevices: ["d1"] }));
  });

  it("expired / requester / duplicate / not-found guards", () => {
    const clock = makeClock();
    const s = createDiscoverySession({ requester: "u1", targetUser: "u2", ttlMs: 1000, clock });
    assert.doesNotThrow(() => assertNotExpired(s, clock()));
    assert.throws(() => assertNotExpired(s, clock() + 2000), DiscoveryExpiredError);
    assert.doesNotThrow(() => assertRequester(s, "u1"));
    assert.throws(() => assertRequester(s, "other"), UnauthorizedDiscoveryError);
    assert.throws(() => assertNoDuplicateDiscovery(s), DuplicateDiscoveryError);
    assert.doesNotThrow(() => assertNoDuplicateDiscovery(null));
    assert.throws(() => requireDiscoverySession(null, "x"), DiscoveryNotFoundError);
  });

  it("repository contract validators", () => {
    assert.throws(() => validateSessionRepository({}), DiscoveryValidationError);
    assert.throws(() => validateRegistryRepository({ upsert() {} }), DiscoveryValidationError);
  });
});

// ---------------------------------------------------------------------------
describe("validators — no-secret invariant (the core security property)", () => {
  for (const secret of FORBIDDEN_SECRET_KEYS) {
    it(`rejects a record carrying "${secret}"`, () => {
      assert.throws(() => assertNoSecretMaterial({ userId: "u", [secret]: "leak" }), CorruptedDiscoveryMetadataError);
    });
  }

  it("scans nested + array structures", () => {
    assert.throws(() => assertNoSecretMaterial({ a: { b: [{ privateKey: "x" }] } }), CorruptedDiscoveryMetadataError);
    assert.doesNotThrow(() => assertNoSecretMaterial({ a: { b: [{ publicKey: "ok" }] } }));
  });

  it("tolerates cyclic graphs without infinite recursion", () => {
    const node = { userId: "u" };
    node.self = node;
    assert.doesNotThrow(() => assertNoSecretMaterial(node));
  });

  it("validateDiscoveryMetadata catches corruption + count mismatch", () => {
    assert.throws(() => validateDiscoveryMetadata({ userId: "u" }), CorruptedDiscoveryMetadataError);
    assert.throws(() => validateDiscoveryMetadata({ userId: "u", deviceIds: ["d1"], devices: [], resolvedAt: "t" }), CorruptedDiscoveryMetadataError);
    const good = createDiscoveryMetadata({ userId: "u", devices: [createDeviceDescriptor({ userId: "u", deviceId: "d1", publicKey: "P" })] });
    assert.doesNotThrow(() => validateDiscoveryMetadata(good));
  });

  it("validateDiscoverySession requires core fields + a known state", () => {
    assert.throws(() => validateDiscoverySession({ discoveryId: "x" }), CorruptedDiscoveryMetadataError);
    assert.throws(() => validateDiscoverySession({ discoveryId: "x", requester: "u1", targetUser: "u2", state: "weird" }), CorruptedDiscoveryMetadataError);
  });
});

// ---------------------------------------------------------------------------
describe("serializers — public DTOs never leak internals", () => {
  it("session DTO exposes flags + strips audit unless requested", () => {
    const clock = makeClock();
    const s = createDiscoverySession({ requester: "u1", targetUser: "u2", clock });
    s.audit = [createAuditEntry("created")];
    const dto = toPublicDiscoverySession(s);
    assert.equal(dto.isActive, true);
    assert.equal(dto.audit, undefined);
    assert.deepEqual(toPublicDiscoverySession(s, { includeAudit: true }).audit.length, 1);
  });

  it("device + metadata DTOs surface public keys + inert placeholders only", () => {
    const d = toPublicDeviceDescriptor(createDeviceDescriptor({ userId: "u", deviceId: "d", publicKey: "PUB", fingerprint: "fp" }));
    assert.equal(d.publicKey, "PUB");
    assert.equal(d.transport.enabled, false);
    const m = toPublicDiscoveryMetadata(createDiscoveryMetadata({ userId: "u", devices: [] }));
    assert.equal(m.userId, "u");
    assert.ok(Array.isArray(m.devices));
    assert.equal(toPublicDiscoveryMetadata(null), null);
  });

  it("status DTO is compact + poll-ready", () => {
    const clock = makeClock();
    const s = createDiscoverySession({ requester: "u1", targetUser: "u2", clock });
    s.state = DiscoveryState.RESOLVED;
    s.result = createDiscoveryMetadata({ userId: "u2", devices: [createDeviceDescriptor({ userId: "u2", deviceId: "d", publicKey: "P" })] });
    const st = toDiscoveryStatus(s);
    assert.equal(st.isResolved, true);
    assert.equal(st.deviceCount, 1);
  });
});
