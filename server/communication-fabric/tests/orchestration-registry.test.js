/**
 * Orchestration + Registry + repository tests (Layer 12, Sprint 1). Verifies end-to-end execution
 * delegates to registered subsystem adapters, the lifecycle events fire in order, fallbacks recover a
 * failed step, required-step failure surfaces as a failed execution, optional-step failure is tolerated,
 * decisions/plans/executions persist, and diagnostics read back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFabric, directRequest, groupRequest, countEvents } from "./helpers.js";
import { createSubsystemRegistry } from "../registry/subsystemRegistry.js";
import { createRecordingAdapter } from "../registry/subsystemAdapter.js";
import { FabricEventType, ExecutionStatus, StepStatus, SubsystemKind } from "../types/types.js";

test("execute delegates to the messaging adapter + completes", async () => {
  const { api, adapters } = makeFabric();
  const result = await api.execute(directRequest({ availability: { status: "online" } }), { callerId: "alice" });
  assert.equal(result.status, ExecutionStatus.COMPLETED);
  assert.ok(adapters.messaging.calls.some((c) => c.action === "deliver"), "messaging adapter should have been called");
});

test("the full lifecycle emits events in order", async () => {
  const { api, captured } = makeFabric();
  await api.execute(directRequest({ availability: { status: "online" } }), { callerId: "alice" });
  const order = [
    FabricEventType.COMMUNICATION_REQUESTED,
    FabricEventType.CONTEXT_BUILT,
    FabricEventType.DECISION_CREATED,
    FabricEventType.STRATEGY_SELECTED,
    FabricEventType.EXECUTION_PLANNED,
    FabricEventType.EXECUTION_STARTED,
    FabricEventType.EXECUTION_COMPLETED,
  ];
  const seen = captured.map((e) => e.type);
  let idx = -1;
  for (const type of order) {
    const at = seen.indexOf(type, idx + 1);
    assert.ok(at > idx, `event ${type} should appear after the previous lifecycle event`);
    idx = at;
  }
});

test("group execution delegates to group + delivery subsystems", async () => {
  const { api, adapters } = makeFabric();
  const result = await api.execute(groupRequest(), { callerId: "alice" });
  assert.equal(result.status, ExecutionStatus.COMPLETED);
  assert.ok(adapters.group.calls.some((c) => c.action === "fanout"));
});

test("a required step failure falls back to an alternate route", async () => {
  // the direct-transport route fails, but the fallback chain routes 'deliver' via relayed/store-and-forward
  const { api } = makeFabric({ failRoutes: ["direct-transport"] });
  const result = await api.execute(directRequest({ availability: { status: "online" } }), { callerId: "alice" });
  const step = result.execution.steps.find((s) => s.action === "deliver");
  assert.equal(step.status, StepStatus.FELL_BACK, "the deliver step should recover via fallback");
  assert.equal(result.status, ExecutionStatus.COMPLETED);
});

test("a required step with no viable fallback fails the execution", async () => {
  // fail EVERY messaging action so the fallback re-homed onto messaging also fails
  const { api, manager } = makeFabric({ subsystems: [] });
  manager.registerSubsystem(createRecordingAdapter({ kind: SubsystemKind.MESSAGING, alwaysFail: true }));
  const result = await api.execute(directRequest({ availability: { status: "online" } }), { callerId: "alice" });
  assert.equal(result.status, ExecutionStatus.FAILED);
});

test("an optional step failing does not fail the execution", async () => {
  // group plan's 'register-receipt' (delivery) is optional; fail it and the overall status is still ok-ish
  const { api } = makeFabric({ failActions: ["register-receipt"] });
  const result = await api.execute(groupRequest(), { callerId: "alice" });
  assert.ok([ExecutionStatus.COMPLETED, ExecutionStatus.PARTIAL].includes(result.status));
  const receipt = result.execution.steps.find((s) => s.action === "register-receipt");
  assert.equal(receipt.status, StepStatus.FAILED);
});

test("a missing subsystem auto-records (foundation stays functional)", async () => {
  // register only messaging; group send needs group + delivery → auto-recorded, execution still completes
  const { manager } = makeFabric({ subsystems: [SubsystemKind.MESSAGING] });
  const api = (await import("../api/fabricApi.js")).createFabricApi(manager);
  const result = await api.execute(groupRequest(), { callerId: "alice" });
  assert.equal(result.status, ExecutionStatus.COMPLETED);
});

test("decisions, plans, executions persist + diagnostics read back", async () => {
  const { api, manager, repo } = makeFabric();
  const result = await api.execute(directRequest({ requestId: "req-persist", availability: { status: "online" } }), { callerId: "alice" });
  const counts = repo._counts();
  assert.equal(counts.decisions, 1);
  assert.equal(counts.plans, 1);
  assert.equal(counts.executions, 1);
  const diag = await manager.decisionDiagnostics("req-persist");
  assert.equal(diag.decisions.length, 1);
  assert.equal(diag.executionStatus, ExecutionStatus.COMPLETED);
  assert.ok(diag.audit.length >= 3);
});

test("dry run plans without executing", async () => {
  const { api, repo } = makeFabric();
  const result = await api.plan(directRequest({ availability: { status: "online" } }), { callerId: "alice" });
  assert.ok(result.plan);
  assert.equal(result.execution, null);
  assert.equal(repo._counts().executions, 0);
});

test("health reports strategies, subsystems, policies, cache", async () => {
  const { manager } = makeFabric();
  const health = await manager.health();
  assert.equal(health.status, "ok");
  assert.ok(health.strategies.length >= 5);
  assert.ok(health.subsystems.length >= 1);
  assert.ok(health.policies.length >= 5);
  assert.ok(health.decisionCache);
});
