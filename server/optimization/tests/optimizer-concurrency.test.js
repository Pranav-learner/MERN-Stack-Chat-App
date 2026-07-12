/**
 * Global Optimizer end-to-end + dispatch + diagnostics + concurrency + Fabric-integration + regression
 * tests (Layer 12, Sprint 3).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOptimizer, directRequest, groupRequest, mediaRequest, syncRequest, urgentRequest } from "./helpers.js";
import { createFabricOptimizationIntegration } from "../integration/fabricIntegration.js";
import { CommunicationFabricManager, createInMemoryFabricRepository } from "../_fabric.js";
import { createSubsystemAdapter } from "../../communication-fabric/registry/subsystemAdapter.js";
import { SubsystemKind, ALL_SUBSYSTEM_KINDS } from "../../communication-fabric/types/types.js";
import { OptimizationEventType, ExecutionState } from "../types/types.js";
import { UnauthorizedOptimizationError } from "../errors.js";

test("optimize produces the full pipeline result + persists", async () => {
  const { api, repo } = makeOptimizer();
  const r = await api.schedule(directRequest({ requestId: "o1" }), { callerId: "alice" });
  assert.ok(r.qos && r.scheduling && r.resources && r.coordination && r.balance && r.optimizedPlan);
  assert.equal(repo._counts().optimizations, 1);
});

test("the full pipeline emits every lifecycle event", async () => {
  const { api, captured } = makeOptimizer();
  await api.schedule(directRequest(), { callerId: "alice" });
  const types = new Set(captured.map((e) => e.type));
  for (const t of [OptimizationEventType.RESOURCES_COLLECTED, OptimizationEventType.QOS_EVALUATED, OptimizationEventType.EXECUTION_SCHEDULED, OptimizationEventType.RESOURCES_ALLOCATED, OptimizationEventType.DEVICES_COORDINATED, OptimizationEventType.WORKLOAD_BALANCED, OptimizationEventType.OPTIMIZATION_COMPLETED]) {
    assert.ok(types.has(t), `missing event ${t}`);
  }
});

test("authorization: caller must be the sender", async () => {
  const { api } = makeOptimizer();
  await assert.rejects(() => api.schedule(directRequest({ senderId: "alice" }), { callerId: "mallory" }), UnauthorizedOptimizationError);
});

test("diagnostics reads back the stored optimization", async () => {
  const { api, optimizer } = makeOptimizer();
  await api.schedule(directRequest({ requestId: "diag-1" }), { callerId: "alice" });
  const diag = await optimizer.diagnostics("diag-1");
  assert.ok(diag.optimization);
  assert.ok(diag.audit.length >= 1);
});

test("immediate execution allocates resources; dispatch drains deferred work", async () => {
  const { api, optimizer } = makeOptimizer();
  // a deferred sync goes into the background lane
  await api.schedule(syncRequest({ requestId: "s-def" }), { callerId: "alice" });
  const before = optimizer.getSchedulerState();
  assert.ok(before.scheduler.total >= 1, "sync should be queued");
  const drained = optimizer.dispatch({ maxConcurrent: 10 });
  assert.ok(drained.count >= 1);
  assert.equal(optimizer.executionCoordinator.stateOf("s-def"), ExecutionState.RUNNING);
  optimizer.complete("s-def");
  assert.equal(optimizer.executionCoordinator.stateOf("s-def"), ExecutionState.COMPLETED);
});

test("resource allocation endpoint recommends without reserving", async () => {
  const { api, optimizer } = makeOptimizer();
  const alloc = await api.getResourceAllocation(mediaRequest(), { callerId: "alice" });
  assert.ok(alloc.cost.bandwidth > 0);
  assert.ok(alloc.recommendation);
  assert.equal(optimizer.resourceManager.snapshot().budgets.bandwidth.allocated, 0, "no reservation from a dry run");
});

test("100 concurrent optimizations all succeed + persist", async () => {
  const { api, repo } = makeOptimizer();
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push(api.schedule(directRequest({ requestId: `c${i}` }), { callerId: "alice" }));
  const results = await Promise.all(jobs);
  assert.equal(results.length, 100);
  assert.ok(results.every((r) => r.qos.qosClass === "normal"));
  assert.equal(repo._counts().optimizations, 100);
});

test("mixed concurrent workload classifies correctly per type (no cross-talk)", async () => {
  const { api } = makeOptimizer();
  const jobs = [];
  for (let i = 0; i < 25; i++) {
    jobs.push(api.schedule(urgentRequest({ requestId: `u${i}` }), { callerId: "alice" }));
    jobs.push(api.schedule(syncRequest({ requestId: `s${i}` }), { callerId: "alice" }));
    jobs.push(api.schedule(mediaRequest({ requestId: `m${i}` }), { callerId: "alice" }));
  }
  const results = await Promise.all(jobs);
  assert.equal(results.filter((r) => r.qos.qosClass === "critical").length, 25);
  assert.equal(results.filter((r) => r.qos.qosClass === "background").length, 25);
  assert.equal(results.filter((r) => r.scheduling.mode === "batch").length, 25);
});

test("Fabric integration: an immediate communication proceeds to orchestration", async () => {
  const optimizerBundle = makeOptimizer();
  const integration = createFabricOptimizationIntegration({ optimizer: optimizerBundle.optimizer });
  const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository(), ...integration });
  for (const kind of ALL_SUBSYSTEM_KINDS) if (kind !== SubsystemKind.VOICE && kind !== SubsystemKind.VIDEO) fabric.registerSubsystem(createSubsystemAdapter({ kind, handler: () => ({ ok: true }) }));

  const result = await fabric.execute(urgentRequest(), { callerId: "alice" });
  assert.equal(result.status, "completed", "critical/urgent proceeds immediately");
});

test("Fabric integration: a background communication is DEFERRED by the optimizer", async () => {
  const optimizerBundle = makeOptimizer();
  const integration = createFabricOptimizationIntegration({ optimizer: optimizerBundle.optimizer });
  const fabric = new CommunicationFabricManager({ ...createInMemoryFabricRepository(), ...integration });
  for (const kind of ALL_SUBSYSTEM_KINDS) if (kind !== SubsystemKind.VOICE && kind !== SubsystemKind.VIDEO) fabric.registerSubsystem(createSubsystemAdapter({ kind, handler: () => ({ ok: true }) }));

  const result = await fabric.execute(syncRequest(), { callerId: "alice" });
  assert.equal(result.status, "deferred", "sync is scheduled to the background, not orchestrated now");
  assert.equal(result.execution, null);
  // and the optimizer holds it for a later dispatch
  assert.ok(optimizerBundle.optimizer.getSchedulerState().scheduler.total >= 1);
});
