/**
 * Engine end-to-end + explanation + diagnostics + caching + concurrency + Fabric-integration + regression
 * tests (Layer 12, Sprint 2).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, directRequest, groupRequest, mediaRequest, syncRequest } from "./helpers.js";
import { createFabricAdaptiveIntegration } from "../integration/fabricIntegration.js";
import { CommunicationFabricManager, createInMemoryFabricRepository, createSubsystemAdapter, SubsystemKind, ALL_SUBSYSTEM_KINDS } from "../_fabric.js";
import { AdaptiveEventType, StrategyType, RouteKind } from "../types/types.js";
import { UnauthorizedAdaptiveError } from "../errors.js";

test("evaluate produces a full explainable decision + execution plan", async () => {
  const { api } = makeEngine();
  const result = await api.evaluate(directRequest({ network: { p2p: true } }), { callerId: "alice" });
  assert.equal(result.selection.strategy, StrategyType.DIRECT);
  assert.ok(result.executionPlan.steps.length >= 1);
  assert.ok(result.explanation.summary.includes("direct"));
  assert.ok(Array.isArray(result.explanation.rejected));
  assert.ok(result.explanation.why.length > 0);
});

test("the full pipeline emits every lifecycle event", async () => {
  const { api, captured } = makeEngine();
  await api.evaluate(directRequest(), { callerId: "alice" });
  const types = new Set(captured.map((e) => e.type));
  for (const t of [AdaptiveEventType.CAPABILITIES_COLLECTED, AdaptiveEventType.COMMUNICATION_ANALYZED, AdaptiveEventType.NETWORK_ANALYZED, AdaptiveEventType.POLICIES_EVALUATED, AdaptiveEventType.ROUTES_SCORED, AdaptiveEventType.STRATEGY_SELECTED, AdaptiveEventType.FALLBACK_GENERATED, AdaptiveEventType.EXECUTION_PLANNED, AdaptiveEventType.DECISION_EXPLAINED]) {
    assert.ok(types.has(t), `missing event ${t}`);
  }
});

test("evaluate persists the evaluation + diagnostics read it back", async () => {
  const { api, engine, repo } = makeEngine();
  await api.evaluate(directRequest({ requestId: "req-1", network: { p2p: true } }), { callerId: "alice" });
  assert.equal(repo._counts().evaluations, 1);
  assert.ok(repo._counts().capabilities >= 1);
  const diag = await engine.diagnostics("req-1");
  assert.equal(diag.evaluation.selection.strategy, StrategyType.DIRECT);
  assert.ok(diag.audit.length >= 1);
});

test("authorization: caller must be the sender", async () => {
  const { api } = makeEngine();
  await assert.rejects(() => api.evaluate(directRequest({ senderId: "alice" }), { callerId: "mallory" }), UnauthorizedAdaptiveError);
});

test("evaluation ranking is cached for identical inputs", async () => {
  const { api, engine } = makeEngine();
  await api.evaluate(directRequest({ requestId: "c1", network: { p2p: true } }), { callerId: "alice" });
  await api.evaluate(directRequest({ requestId: "c2", network: { p2p: true } }), { callerId: "alice" });
  assert.ok(engine.evalCache.stats().hits >= 1);
});

test("capability profile endpoint returns negotiated + per-party profiles", async () => {
  const { api } = makeEngine();
  const profile = await api.getCapabilityProfile({ senderId: "alice", recipients: ["bob"] });
  assert.ok(profile.negotiated.transports.length > 0);
  assert.ok(profile.negotiated.fingerprint);
});

test("100 concurrent evaluations all succeed + persist", async () => {
  const { api, repo } = makeEngine();
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push(api.evaluate(directRequest({ requestId: `k${i}`, network: { p2p: true } }), { callerId: "alice" }));
  const results = await Promise.all(jobs);
  assert.equal(results.length, 100);
  assert.ok(results.every((r) => r.selection.strategy === StrategyType.DIRECT));
  assert.equal(repo._counts().evaluations, 100);
});

test("mixed concurrent workload selects correctly per type (no cross-talk)", async () => {
  const { api } = makeEngine();
  const jobs = [];
  for (let i = 0; i < 30; i++) {
    jobs.push(api.evaluate(directRequest({ requestId: `d${i}`, network: { p2p: true } }), { callerId: "alice" }));
    jobs.push(api.evaluate(groupRequest({ requestId: `g${i}` }), { callerId: "alice" }));
    jobs.push(api.evaluate(mediaRequest({ requestId: `m${i}` }), { callerId: "alice" }));
    jobs.push(api.evaluate(syncRequest({ requestId: `s${i}` }), { callerId: "alice" }));
  }
  const results = await Promise.all(jobs);
  assert.equal(results.filter((r) => r.selection.strategy === StrategyType.GROUP).length, 30);
  assert.equal(results.filter((r) => r.selection.strategy === StrategyType.MEDIA).length, 30);
  assert.equal(results.filter((r) => r.selection.strategy === StrategyType.SYNCHRONIZATION).length, 30);
});

test("Fabric integration makes the existing Communication Fabric adaptive (p2p down → relay route metadata)", async () => {
  const registry = (await import("../_fabric.js")).createDefaultStrategyRegistry();
  const integration = createFabricAdaptiveIntegration({ strategyRegistry: registry, providers: { network: () => ({ p2p: false, relay: true }) } });
  const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository(), strategyRegistry: registry, ...integration });
  for (const kind of ALL_SUBSYSTEM_KINDS) if (kind !== SubsystemKind.VOICE && kind !== SubsystemKind.VIDEO) fabric.registerSubsystem(createSubsystemAdapter({ kind, handler: () => ({ ok: true }) }));

  const result = await fabric.execute(directRequest(), { callerId: "alice" });
  // the adaptive route planner attached scored, ranked routes + adaptive diagnostics
  assert.equal(result.plan.routing.diagnostics.adaptive, true);
  assert.ok(Array.isArray(result.plan.routing.diagnostics.scores));
  assert.equal(result.status, "completed");
});

test("Fabric integration re-orders selection among native candidates by adaptive score", async () => {
  const registry = (await import("../_fabric.js")).createDefaultStrategyRegistry();
  // p2p down → direct non-viable → among native candidates (direct/offline) offline should win
  const integration = createFabricAdaptiveIntegration({ strategyRegistry: registry, providers: { network: () => ({ p2p: false }) } });
  const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository(), strategyRegistry: registry, ...integration });
  const decision = await fabric.getDecision(directRequest(), { callerId: "alice" });
  assert.equal(decision.strategy, StrategyType.OFFLINE);
});
