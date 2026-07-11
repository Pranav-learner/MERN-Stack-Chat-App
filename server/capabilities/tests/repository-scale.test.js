/**
 * Capability repository contract, validation, concurrency, multi-device, feature-flag, large-scale
 * and performance tests (Layer 6, Sprint 3). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeCapabilities, makeClock, makeIdGen, caps } from "./helpers.js";
import { createInMemoryCapabilityRepository } from "../repository/inMemoryCapabilityRepository.js";
import { createCapabilityRecord } from "../record/capabilityRecord.js";
import {
  validateCapabilityId,
  validateUserRef,
  validateDeviceRef,
  validateVersionList,
  validateTransports,
  validateCompression,
  validateFeatureFlags,
  validateCapabilityRequest,
  assertNoSecretMaterial,
  validateCapabilityRecord,
  validateCapabilityRepository,
  requireCapability,
  FORBIDDEN_SECRET_KEYS,
} from "../validators/validators.js";
import { CapabilityState } from "../types/types.js";
import {
  CapabilityValidationError,
  CapabilityNotFoundError,
  CorruptedCapabilityError,
} from "../errors.js";

// ---------------------------------------------------------------------------
describe("capability repository — contract", () => {
  let repo, idGen;
  beforeEach(() => {
    ({ capabilities: repo } = createInMemoryCapabilityRepository());
    idGen = makeIdGen("rec");
  });
  const rec = (userId, deviceId, over = {}) => createCapabilityRecord({ userId, deviceId, clock: makeClock(), idGenerator: idGen, ...over });

  it("create / findById / findByUserAndDevice / update / delete + deep-copy", async () => {
    const r = rec("u1", "d1");
    await repo.create(r);
    const got = await repo.findById(r.capabilityId);
    got.state = "removed"; // mutate the copy
    assert.equal((await repo.findById(r.capabilityId)).state, CapabilityState.REGISTERED); // store untouched
    assert.equal((await repo.findByUserAndDevice("u1", "d1")).capabilityId, r.capabilityId);
    await repo.update(r.capabilityId, { state: CapabilityState.ADVERTISED });
    assert.equal((await repo.findById(r.capabilityId)).state, CapabilityState.ADVERTISED);
    await assert.rejects(() => repo.update("missing-00000000", {}), CapabilityNotFoundError);
    assert.equal(await repo.delete(r.capabilityId), true);
    assert.equal(await repo.findByUserAndDevice("u1", "d1"), null);
  });

  it("upsert replaces a stale set for the same device", async () => {
    const a = rec("u1", "d1");
    await repo.upsert(a);
    const b = rec("u1", "d1");
    await repo.upsert(b);
    assert.equal(await repo.findById(a.capabilityId), null);
    assert.equal((await repo.findByUser("u1")).length, 1);
  });

  it("listByState / listExpired / countByState", async () => {
    const clock = makeClock();
    await repo.create(createCapabilityRecord({ userId: "u1", deviceId: "d1", state: undefined, ttlMs: 1000, clock, idGenerator: makeIdGen("a") }));
    const adv = createCapabilityRecord({ userId: "u1", deviceId: "d2", ttlMs: 1000, clock, idGenerator: makeIdGen("b") });
    adv.state = CapabilityState.ADVERTISED;
    await repo.create(adv);
    assert.equal((await repo.listByState(CapabilityState.REGISTERED)).length, 1);
    assert.equal((await repo.listExpired(new Date(clock() + 5000).toISOString())).length, 2); // both live + overdue
    const counts = await repo.countByState();
    assert.equal(counts.registered, 1);
    assert.equal(counts.advertised, 1);
  });
});

// ---------------------------------------------------------------------------
describe("negotiation-history repository — contract", () => {
  it("record / findById / listByDevice / listByPair", async () => {
    const { negotiations } = createInMemoryCapabilityRepository();
    const base = { requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1", state: "succeeded", result: {}, createdAt: "2026-01-01T00:00:00.000Z" };
    await negotiations.record({ ...base, negotiationId: "neg-1" });
    await negotiations.record({ ...base, negotiationId: "neg-2", createdAt: "2026-01-02T00:00:00.000Z" });
    assert.ok(await negotiations.findById("neg-1"));
    const byDevice = await negotiations.listByDevice("u2", "d1");
    assert.equal(byDevice.length, 2);
    assert.equal(byDevice[0].negotiationId, "neg-2"); // most recent first
    const byPair = await negotiations.listByPair("u2", "d1", "u1", "d1"); // reversed pair still matches
    assert.equal(byPair.length, 2);
    assert.equal((await negotiations.listByDevice("u2", "d1", { limit: 1 })).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("validators", () => {
  it("id / ref / version / transport / compression / flag guards", () => {
    assert.equal(validateCapabilityId("abcd1234ef"), "abcd1234ef");
    assert.throws(() => validateCapabilityId("short"), CapabilityValidationError);
    assert.throws(() => validateUserRef("bad id!"), CapabilityValidationError);
    assert.equal(validateDeviceRef("dev.1:2"), "dev.1:2");
    assert.throws(() => validateVersionList([], "protocolVersions"), CapabilityValidationError);
    assert.throws(() => validateVersionList(["x"], "protocolVersions"), CapabilityValidationError);
    assert.throws(() => validateTransports(["bogus"]), CapabilityValidationError);
    assert.throws(() => validateTransports([]), CapabilityValidationError);
    assert.throws(() => validateCompression(["zip"]), CapabilityValidationError);
    assert.throws(() => validateFeatureFlags({ a: "no" }), CapabilityValidationError);
    assert.doesNotThrow(() => validateFeatureFlags({ a: true, b: false }));
  });

  it("validateCapabilityRequest catches malformed requests", () => {
    assert.throws(() => validateCapabilityRequest(null), CapabilityValidationError);
    assert.throws(() => validateCapabilityRequest({ userId: "u1" }), CapabilityValidationError); // no deviceId
    assert.throws(() => validateCapabilityRequest({ userId: "u1", deviceId: "d1", maxPayloadSize: -1 }), CapabilityValidationError);
    assert.throws(() => validateCapabilityRequest({ userId: "u1", deviceId: "d1", metadata: [1] }), CapabilityValidationError);
    assert.throws(() => validateCapabilityRequest({ userId: "u1", deviceId: "d1", transports: ["quic"], protocolVersions: ["2.x"] }), CapabilityValidationError);
    assert.doesNotThrow(() => validateCapabilityRequest({ userId: "u1", deviceId: "d1", transports: ["relay"] }));
  });

  it("requireCapability + record validation + repository contract", () => {
    assert.throws(() => requireCapability(null, "x"), CapabilityNotFoundError);
    assert.throws(() => validateCapabilityRecord({ capabilityId: "x" }), CorruptedCapabilityError);
    assert.throws(() => validateCapabilityRepository({}), CapabilityValidationError);
  });

  it("no-secret invariant: rejects every forbidden key (incl. nested + cyclic)", () => {
    for (const secret of FORBIDDEN_SECRET_KEYS) {
      assert.throws(() => assertNoSecretMaterial({ userId: "u", [secret]: "leak" }), CorruptedCapabilityError);
    }
    assert.throws(() => assertNoSecretMaterial({ a: { b: [{ sessionKey: "x" }] } }), CorruptedCapabilityError);
    const node = { userId: "u" };
    node.self = node;
    assert.doesNotThrow(() => assertNoSecretMaterial(node));
  });
});

// ---------------------------------------------------------------------------
describe("feature flags negotiation semantics", () => {
  it("only flags BOTH devices enable survive negotiation", async () => {
    const ctx = makeCapabilities();
    await ctx.manager.registerCapabilities(caps("u1", "d1", { featureFlags: { typing: true, reactions: true, voice: false } }));
    await ctx.manager.registerCapabilities(caps("u2", "d1", { featureFlags: { typing: true, reactions: false, voice: true } }));
    const { result } = await ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.deepEqual(result.featureFlags, { typing: true }); // reactions off on one side, voice off on other
  });

  it("unknown feature flags are carried + negotiated (extensible)", async () => {
    const ctx = makeCapabilities();
    await ctx.manager.registerCapabilities(caps("u1", "d1", { featureFlags: { experimentalX: true } }));
    await ctx.manager.registerCapabilities(caps("u2", "d1", { featureFlags: { experimentalX: true } }));
    const { result } = await ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" });
    assert.equal(result.featureFlags.experimentalX, true);
  });
});

// ---------------------------------------------------------------------------
describe("concurrency", () => {
  it("concurrent negotiations of the same pair all resolve consistently", async () => {
    const ctx = makeCapabilities();
    await ctx.manager.registerCapabilities(caps("u1", "d1", { transports: ["websocket", "relay"] }));
    await ctx.manager.registerCapabilities(caps("u2", "d1", { transports: ["relay"] }));
    const results = await Promise.all(Array.from({ length: 25 }, () => ctx.manager.negotiate({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevice: "d1" })));
    assert.ok(results.every((r) => r.result.compatible && r.result.preferredTransport === "relay"));
  });

  it("concurrent registrations of distinct devices all persist", async () => {
    const ctx = makeCapabilities();
    await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.manager.registerCapabilities(caps("u1", `d${i}`))));
    assert.equal((await ctx.manager.listUserCapabilities("u1")).length, 20);
  });
});

// ---------------------------------------------------------------------------
describe("large-scale + performance", () => {
  it("registers 1000 devices and negotiates a fan-out from one hub device", async () => {
    const ctx = makeCapabilities({ cacheOptions: { limit: 500 } });
    await ctx.manager.registerCapabilities(caps("hub", "d1", { transports: ["webrtc", "websocket", "relay"] }));
    await Promise.all(Array.from({ length: 1000 }, (_, i) => ctx.manager.registerCapabilities(caps(`u${i}`, "d1", { transports: i % 2 ? ["relay"] : ["websocket"] }))));
    const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => ctx.manager.negotiate({ requester: "hub", requesterDevice: "d1", targetUser: `u${i}`, targetDevice: "d1" })));
    assert.equal(results.filter((r) => r.result.compatible).length, 1000);
    assert.equal(results.filter((r) => r.result.preferredTransport === "relay").length, 500);
    assert.equal(results.filter((r) => r.result.preferredTransport === "websocket").length, 500);
  });

  it("1000 cached negotiations stay well under a generous budget", async () => {
    const ctx = makeCapabilities();
    await ctx.manager.registerCapabilities(caps("a", "d1"));
    await ctx.manager.registerCapabilities(caps("b", "d1"));
    await ctx.manager.negotiate({ requester: "a", requesterDevice: "d1", targetUser: "b", targetDevice: "d1" }); // warm
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) await ctx.manager.negotiate({ requester: "a", requesterDevice: "d1", targetUser: "b", targetDevice: "d1" });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `1000 cached negotiations took ${ms}ms`);
    assert.ok(ctx.manager.cacheStats().hits >= 1000);
  });

  it("repository device lookup is O(1)-ish across 3000 sets", async () => {
    const { capabilities } = createInMemoryCapabilityRepository();
    const clock = makeClock();
    for (let i = 0; i < 3000; i++) await capabilities.create(createCapabilityRecord({ userId: `u${i}`, deviceId: "d1", clock, idGenerator: makeIdGen(`k${i}`) }));
    const start = process.hrtime.bigint();
    const found = await capabilities.findByUserAndDevice("u1500", "d1");
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(found);
    assert.ok(ms < 50, `findByUserAndDevice took ${ms}ms`);
  });
});
