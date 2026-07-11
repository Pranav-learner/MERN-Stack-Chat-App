/**
 * PDP repository contract, validation, concurrency, multi-device, and large-scale/performance tests
 * (Layer 6, Sprint 4). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makePdp, makeClock, makeIdGen } from "./helpers.js";
import { createInMemoryPdpRepository } from "../repositories/inMemoryPdpRepository.js";
import { createPdpSession } from "../workflow/session.js";
import { createConnectionPlan } from "../planner/connectionPlan.js";
import {
  validateDiscoveryId,
  validatePlanId,
  validateUserRef,
  validateDeviceRef,
  validateSelectionPolicy,
  validateStartRequest,
  assertNoSecretMaterial,
  validateConnectionPlan,
  validatePdpSession,
  validateSessionRepository,
  validatePlanRepository,
  requirePdpSession,
  FORBIDDEN_SECRET_KEYS,
} from "../validators/validators.js";
import { PdpState } from "../types/types.js";
import { PdpValidationError, PdpNotFoundError, CorruptedPlanError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("session repository — contract", () => {
  let repo;
  beforeEach(() => {
    ({ sessions: repo } = createInMemoryPdpRepository());
  });
  const sess = (over = {}) => createPdpSession({ requester: "u1", requesterDevice: "d1", targetUser: "u2", clock: makeClock(), idGenerator: makeIdGen("s"), ...over });

  it("create / findById / update / delete + deep-copy", async () => {
    const s = sess();
    await repo.create(s);
    const got = await repo.findById(s.discoveryId);
    got.state = PdpState.FAILED; // mutate the copy
    assert.equal((await repo.findById(s.discoveryId)).state, PdpState.CREATED); // store untouched
    await repo.update(s.discoveryId, { state: PdpState.RESOLVING });
    assert.equal((await repo.findById(s.discoveryId)).state, PdpState.RESOLVING);
    await assert.rejects(() => repo.update("missing-00000000", {}), PdpNotFoundError);
    assert.equal(await repo.delete(s.discoveryId), true);
    assert.equal(await repo.findById(s.discoveryId), null);
  });

  it("findActiveByDedupeKey + listByRequester + listExpired", async () => {
    const clock = makeClock();
    const a = createPdpSession({ requester: "u1", requesterDevice: "d1", targetUser: "u2", ttlMs: 1000, clock, idGenerator: makeIdGen("a") });
    await repo.create(a);
    const { pdpDedupeKey } = await import("../workflow/session.js");
    assert.ok(await repo.findActiveByDedupeKey(pdpDedupeKey(a)));
    assert.equal((await repo.listByRequester("u1")).length, 1);
    assert.equal((await repo.listExpired(new Date(clock() + 5000).toISOString())).length, 1);
    await repo.update(a.discoveryId, { state: PdpState.COMPLETED });
    assert.equal(await repo.findActiveByDedupeKey(pdpDedupeKey(a)), null); // completed no longer active
  });
});

// ---------------------------------------------------------------------------
describe("plan repository — contract", () => {
  it("create / findById / findByDiscoveryId / listByRequester / delete", async () => {
    const { plans } = createInMemoryPdpRepository();
    const plan = createConnectionPlan({ discoveryId: "disc-1", requester: "u1", requesterDevice: "d1", targetUser: "u2", selectedDevices: [{ deviceId: "x", capabilities: {}, score: 0.5, rank: 0, priority: 50 }], presenceSnapshot: [], selectionPolicy: "capability-score", clock: makeClock(), idGenerator: makeIdGen("p") });
    await plans.create(plan);
    assert.equal((await plans.findById(plan.planId)).discoveryId, "disc-1");
    assert.equal((await plans.findByDiscoveryId("disc-1")).planId, plan.planId);
    assert.equal((await plans.listByRequester("u1")).length, 1);
    assert.equal(await plans.delete(plan.planId), true);
    assert.equal(await plans.findByDiscoveryId("disc-1"), null);
  });
});

// ---------------------------------------------------------------------------
describe("validators", () => {
  it("id / ref / policy guards", () => {
    assert.equal(validateDiscoveryId("abcd1234ef"), "abcd1234ef");
    assert.throws(() => validateDiscoveryId("short"), PdpValidationError);
    assert.throws(() => validatePlanId("x"), PdpValidationError);
    assert.throws(() => validateUserRef("bad id!"), PdpValidationError);
    assert.equal(validateDeviceRef("dev.1:2"), "dev.1:2");
    assert.throws(() => validateSelectionPolicy("nope"), PdpValidationError);
    assert.doesNotThrow(() => validateSelectionPolicy(undefined));
  });

  it("validateStartRequest catches malformed requests", () => {
    assert.throws(() => validateStartRequest(null), PdpValidationError);
    assert.throws(() => validateStartRequest({ requester: "u1", requesterDevice: "d1" }), PdpValidationError); // no targetUser
    assert.throws(() => validateStartRequest({ requester: "u1", requesterDevice: "d1", targetUser: "u2", maxDevices: 0 }), PdpValidationError);
    assert.throws(() => validateStartRequest({ requester: "u1", requesterDevice: "d1", targetUser: "u2", targetDevices: "x" }), PdpValidationError);
    assert.doesNotThrow(() => validateStartRequest({ requester: "u1", requesterDevice: "d1", targetUser: "u2" }));
  });

  it("requirePdpSession + record validation + repository contracts", () => {
    assert.throws(() => requirePdpSession(null, "x"), PdpNotFoundError);
    assert.throws(() => validateConnectionPlan({ planId: "x" }), CorruptedPlanError);
    assert.throws(() => validatePdpSession({ discoveryId: "x" }), CorruptedPlanError);
    assert.throws(() => validateSessionRepository({}), PdpValidationError);
    assert.throws(() => validatePlanRepository({}), PdpValidationError);
  });

  it("no-secret invariant: rejects forbidden keys (nested + cyclic safe)", () => {
    for (const secret of FORBIDDEN_SECRET_KEYS) {
      assert.throws(() => assertNoSecretMaterial({ requester: "u", [secret]: "leak" }), CorruptedPlanError);
    }
    assert.throws(() => assertNoSecretMaterial({ a: [{ sessionKey: "x" }] }), CorruptedPlanError);
    const node = { requester: "u" };
    node.self = node;
    assert.doesNotThrow(() => assertNoSecretMaterial(node));
  });

  it("a produced connection plan carries no secret material", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("u1", "d1");
    await ctx.seedUser("u2", [{ deviceId: "x", transports: ["relay"] }]);
    const { plan } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
    assert.doesNotThrow(() => validateConnectionPlan(plan));
  });
});

// ---------------------------------------------------------------------------
describe("concurrency + multi-device", () => {
  it("concurrent DISTINCT-target discoveries all complete independently", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("hub", "d1");
    for (let i = 0; i < 20; i++) await ctx.seedUser(`u${i}`, [{ deviceId: `u${i}-d`, transports: ["relay"] }]);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.manager.startDiscovery({ requester: "hub", requesterDevice: "d1", targetUser: `u${i}` })));
    assert.equal(results.filter((r) => r.session.state === PdpState.COMPLETED).length, 20);
    const ids = new Set(results.map((r) => r.plan.primaryDeviceId));
    assert.equal(ids.size, 20);
  });

  it("selects the best of many devices; caps the selected set", async () => {
    const ctx = makePdp({ maxDevices: 2 });
    await ctx.registerRequester("u1", "d1");
    await ctx.seedUser("u2", [
      { deviceId: "d-poor", transports: ["relay"] },
      { deviceId: "d-rich", transports: ["webrtc", "quic", "relay", "websocket"] },
      { deviceId: "d-mid", transports: ["relay", "websocket"] },
    ]);
    const { plan } = await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
    assert.equal(plan.primaryDeviceId, "d-rich"); // richest shared surface wins
    assert.equal(plan.selectedDevices.length, 2); // capped
  });
});

// ---------------------------------------------------------------------------
describe("large-scale + performance", () => {
  it("a hub resolves connection plans for 200 distinct users", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("hub", "d1");
    for (let i = 0; i < 200; i++) await ctx.seedUser(`peer${i}`, [{ deviceId: `peer${i}-d`, transports: i % 2 ? ["relay"] : ["webrtc", "relay"] }]);
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => ctx.manager.startDiscovery({ requester: "hub", requesterDevice: "d1", targetUser: `peer${i}` })));
    assert.equal(results.filter((r) => r.session.state === PdpState.COMPLETED).length, 200);
  });

  it("cached repeat plans stay well under a generous budget", async () => {
    const ctx = makePdp();
    await ctx.registerRequester("u1", "d1");
    await ctx.seedUser("u2", [{ deviceId: "x", transports: ["relay"] }]);
    await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" }); // warm
    const start = process.hrtime.bigint();
    for (let i = 0; i < 300; i++) await ctx.manager.startDiscovery({ requester: "u1", requesterDevice: "d1", targetUser: "u2" });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1000, `300 cached discoveries took ${ms}ms`);
    assert.ok(ctx.manager.cacheStats().hits >= 300);
  });
});
