/**
 * Endpoint Selection repository contract, validation, concurrency, and large-scale/performance
 * tests (Layer 6, Sprint 5). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeClock, cap, candidate } from "./helpers.js";
import { createInMemoryEndpointRepository } from "../repository/inMemoryEndpointRepository.js";
import { createEndpointConnectionPlan } from "../planner/connectionPlan.js";
import { rankEndpoints } from "../scorer/scoring.js";
import { POLICY_PROFILES } from "../policies/policies.js";
import {
  validatePlanId,
  validateUserRef,
  validateDeviceRef,
  validatePolicy,
  validateCandidates,
  validateGenerateRequest,
  assertNoSecretMaterial,
  validateConnectionPlan,
  validatePlanRepository,
  validateReliabilityRepository,
  requirePlan,
  FORBIDDEN_SECRET_KEYS,
} from "../validators/validators.js";
import { SelectionPolicy, OutcomeType } from "../types/types.js";
import { EndpointValidationError, EndpointNotFoundError, CorruptedPlanError } from "../errors.js";

const W = POLICY_PROFILES[SelectionPolicy.HIGHEST_SCORE].weights;
const makePlan = (id, requester = "u1") =>
  createEndpointConnectionPlan({ planId: id, requester, requesterDevice: "d1", targetUser: "u2", ranked: rankEndpoints([candidate("a")], { now: 1 }, W), policyName: "highest-score", weights: W, clock: makeClock() });

// ---------------------------------------------------------------------------
describe("plan repository — contract", () => {
  let repo;
  beforeEach(() => {
    ({ plans: repo } = createInMemoryEndpointRepository());
  });

  it("create / findById / update / delete + deep-copy", async () => {
    await repo.create(makePlan("plan-0001"));
    const got = await repo.findById("plan-0001");
    got.status = "expired"; // mutate the copy
    assert.equal((await repo.findById("plan-0001")).status, "active"); // store untouched
    await repo.update("plan-0001", { generation: 5 });
    assert.equal((await repo.findById("plan-0001")).generation, 5);
    await assert.rejects(() => repo.update("missing-00000000", {}), EndpointNotFoundError);
    assert.equal(await repo.delete("plan-0001"), true);
    assert.equal(await repo.findById("plan-0001"), null);
  });

  it("listByRequester is scoped + newest-first", async () => {
    await repo.create(makePlan("plan-000a", "u1"));
    await repo.create(makePlan("plan-000b", "u1"));
    await repo.create(makePlan("plan-000c", "u2"));
    assert.equal((await repo.listByRequester("u1")).length, 2);
    assert.equal((await repo.listByRequester("u1", { limit: 1 })).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("reliability + selection repositories — contract", () => {
  it("reliability record/get/getMany with Laplace-smoothed score", async () => {
    const { reliability } = createInMemoryEndpointRepository();
    await reliability.record("u2", "d1", OutcomeType.SUCCESS);
    await reliability.record("u2", "d1", OutcomeType.SUCCESS);
    await reliability.record("u2", "d1", OutcomeType.FAILURE);
    const r = await reliability.get("u2", "d1");
    assert.equal(r.successes, 2);
    assert.equal(r.failures, 1);
    assert.ok(Math.abs(r.reliability - 3 / 5) < 1e-9); // (2+1)/(3+2)
    const many = await reliability.getMany("u2", ["d1", "ghost"]);
    assert.ok(many.d1);
    assert.equal(many.ghost, undefined);
  });

  it("selection history record/list by requester + target", async () => {
    const { selections } = createInMemoryEndpointRepository();
    await selections.record({ selectionId: "sel-1", requester: "u1", targetUser: "u2", action: "generate", at: "2026-01-01T00:00:00.000Z" });
    await selections.record({ selectionId: "sel-2", requester: "u1", targetUser: "u3", action: "generate", at: "2026-01-02T00:00:00.000Z" });
    assert.equal((await selections.listByRequester("u1")).length, 2);
    assert.equal((await selections.listByTarget("u1", "u2")).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("validators", () => {
  it("id / ref / policy guards", () => {
    assert.equal(validatePlanId("abcd1234ef"), "abcd1234ef");
    assert.throws(() => validatePlanId("x"), EndpointValidationError);
    assert.throws(() => validateUserRef("bad id!"), EndpointValidationError);
    assert.equal(validateDeviceRef("dev.1:2"), "dev.1:2");
    assert.throws(() => validatePolicy("nope"), EndpointValidationError);
    assert.doesNotThrow(() => validatePolicy("highest-score"));
    assert.doesNotThrow(() => validatePolicy({ weights: { presence: 1 } }));
  });

  it("candidate validation catches duplicates + malformed", () => {
    assert.throws(() => validateCandidates([]), EndpointValidationError);
    assert.throws(() => validateCandidates([candidate("a"), candidate("a")]), EndpointValidationError); // duplicate
    assert.doesNotThrow(() => validateCandidates([candidate("a"), candidate("b")]));
  });

  it("validateGenerateRequest catches malformed requests", () => {
    assert.throws(() => validateGenerateRequest(null), EndpointValidationError);
    assert.throws(() => validateGenerateRequest({ requester: "u1", requesterDevice: "d1" }), EndpointValidationError); // no targetUser
    assert.throws(() => validateGenerateRequest({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [], }), EndpointValidationError);
    assert.throws(() => validateGenerateRequest({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("a")], maxFallbacks: -1 }), EndpointValidationError);
    assert.doesNotThrow(() => validateGenerateRequest({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("a")] }));
  });

  it("plan validation catches selection conflicts + missing fields; repo contracts", () => {
    assert.throws(() => requirePlan(null, "x"), EndpointNotFoundError);
    assert.throws(() => validateConnectionPlan({ planId: "x" }), CorruptedPlanError);
    // primary must lead the priority order.
    assert.throws(() => validateConnectionPlan({ planId: "p", requester: "u", targetUser: "u2", primaryEndpoint: { deviceId: "a" }, priorityOrder: ["b"] }), CorruptedPlanError);
    assert.throws(() => validatePlanRepository({}), EndpointValidationError);
    assert.throws(() => validateReliabilityRepository({}), EndpointValidationError);
  });

  it("no-secret invariant: rejects forbidden keys (nested + cyclic safe)", () => {
    for (const secret of FORBIDDEN_SECRET_KEYS) {
      assert.throws(() => assertNoSecretMaterial({ requester: "u", [secret]: "leak" }), CorruptedPlanError);
    }
    assert.throws(() => assertNoSecretMaterial({ a: [{ chainKey: "x" }] }), CorruptedPlanError);
    const node = { requester: "u" };
    node.self = node;
    assert.doesNotThrow(() => assertNoSecretMaterial(node));
  });

  it("a produced plan carries no secret material", async () => {
    const ctx = makeManager();
    const { plan } = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: [candidate("a"), candidate("b")] });
    assert.doesNotThrow(() => validateConnectionPlan(plan));
  });
});

// ---------------------------------------------------------------------------
describe("concurrency + scale", () => {
  it("concurrent distinct-target plans all persist", async () => {
    const ctx = makeManager();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => ctx.manager.generateConnectionPlan({ requester: "hub", requesterDevice: "d1", targetUser: `u${i}`, candidates: [candidate("a"), candidate("b")] })));
    assert.equal(results.filter((r) => r.plan.primaryEndpoint).length, 30);
    const planIds = new Set(results.map((r) => r.plan.planId));
    assert.equal(planIds.size, 30);
  });

  it("scores + ranks a user with 50 devices, deterministically", async () => {
    const ctx = makeManager({ maxFallbacks: 5 });
    const many = Array.from({ length: 50 }, (_, i) => candidate(`dev${String(i).padStart(2, "0")}`, { capabilities: cap({ sharedTransports: i % 2 ? ["relay"] : ["webrtc", "quic", "relay", "websocket"] }) }));
    const a = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: many }, { useCache: false });
    const b = await ctx.manager.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates: many }, { useCache: false });
    assert.equal(a.plan.primaryEndpoint.deviceId, b.plan.primaryEndpoint.deviceId); // deterministic
    assert.equal(a.plan.fallbackEndpoints.length, 5); // capped
    assert.equal(a.plan.priorityOrder.length, 6);
  });

  it("1000 rankings of 10 devices stay under a generous budget", () => {
    const ranked = () => rankEndpoints(Array.from({ length: 10 }, (_, i) => candidate(`d${i}`)), { now: 1 }, W);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) ranked();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `1000 rankings took ${ms}ms`);
  });
});
