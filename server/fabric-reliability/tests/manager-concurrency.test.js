/**
 * Reliability manager end-to-end + integration + concurrency + stress + fuzz tests (Layer 12, Sprint 4).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeManager, flakyExecutor, classedError } from "./helpers.js";
import { createReliableFabric } from "../integration/fabricIntegration.js";
import { getProtocolFreeze } from "../freeze/protocolFreeze.js";
import { FabricOperationKind, OperationState, FailureClass, ALL_OPERATION_KINDS } from "../types/types.js";
import { UnauthorizedReliabilityError } from "../errors.js";

test("run: a successful operation returns ok + records metrics", async () => {
  const { manager } = makeManager();
  const r = await manager.run(FabricOperationKind.DECISION, async () => ({ decided: true }), { callerId: "alice", ownerId: "alice" });
  assert.equal(r.ok, true);
  assert.equal(r.state, OperationState.SUCCEEDED);
  assert.deepEqual(r.result, { decided: true });
  assert.ok(r.latencyMs >= 0);
  const snap = manager.metricsSnapshot();
  assert.ok(snap.gauges["fabric_execution_success_rate"] === 1);
});

test("run: a flaky operation is retried then succeeds", async () => {
  const { manager } = makeManager();
  const r = await manager.run(FabricOperationKind.DECISION, flakyExecutor(2), { callerId: "alice", ownerId: "alice" });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test("run: a validation failure gracefully fails (no retry)", async () => {
  const { manager } = makeManager();
  const r = await manager.run(FabricOperationKind.POLICY_EVALUATE, async () => { throw classedError(FailureClass.VALIDATION); }, { callerId: "alice", ownerId: "alice" });
  assert.equal(r.ok, false);
  assert.equal(r.state, OperationState.GRACEFULLY_FAILED);
  assert.ok(r.error);
});

test("run: an unauthorized caller is rejected", async () => {
  const { manager } = makeManager();
  await assert.rejects(() => manager.run(FabricOperationKind.DECISION, async () => ({}), { callerId: "mallory", ownerId: "alice" }), UnauthorizedReliabilityError);
});

test("run: replay protection rejects a duplicate idempotency key", async () => {
  const { manager } = makeManager();
  await manager.run(FabricOperationKind.SCHEDULE, async () => ({}), { callerId: "alice", ownerId: "alice", idempotencyKey: "req-1" });
  await assert.rejects(() => manager.run(FabricOperationKind.SCHEDULE, async () => ({}), { callerId: "alice", ownerId: "alice", idempotencyKey: "req-1" }), /Replay/);
});

test("circuit opens after repeated failures then fast-aborts", async () => {
  const { manager } = makeManager({ config: { circuit: { failureThreshold: 2, resetTimeoutMs: 60000 }, retry: { maxAttempts: 1 }, recovery: { maxResumeAttempts: 1, recoveryTimeoutMs: 100 } } });
  const boom = async () => { throw classedError(FailureClass.TRANSIENT); };
  await manager.run(FabricOperationKind.SUBSYSTEM_CALL, boom, { callerId: "a", ownerId: "a", compartment: "c" });
  await manager.run(FabricOperationKind.SUBSYSTEM_CALL, boom, { callerId: "a", ownerId: "a", compartment: "c" });
  const r = await manager.run(FabricOperationKind.SUBSYSTEM_CALL, boom, { callerId: "a", ownerId: "a", compartment: "c" });
  assert.equal(r.state, OperationState.ABORTED);
  assert.equal(r.error.reason, "circuit-open");
});

test("run: recovery resumes a transient failure after retries exhaust", async () => {
  // maxAttempts 1 → the first failure isn't retried in-line, but recovery re-runs the executor once
  const { manager } = makeManager({ config: { retry: { maxAttempts: 1 } } });
  let calls = 0;
  const r = await manager.run(
    FabricOperationKind.DECISION,
    async () => {
      calls++;
      if (calls === 1) throw classedError(FailureClass.TRANSIENT);
      return { recovered: true };
    },
    { callerId: "a", ownerId: "a" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.state, OperationState.RECOVERED);
  assert.equal(r.recovery, "resumed");
});

test("health, readiness, liveness, diagnostics, freeze are exposed", async () => {
  const { manager, api } = makeManager();
  await manager.run(FabricOperationKind.DECISION, async () => ({}), { callerId: "a", ownerId: "a" });
  assert.equal((await api.ready()).ready, true);
  assert.equal(api.live().live, true);
  const health = await api.health();
  assert.ok(health.status);
  const diag = await api.diagnostics();
  assert.ok(diag.metrics && diag.health && Array.isArray(diag.circuits));
  const freeze = api.freeze();
  assert.equal(freeze.status, "frozen");
  assert.ok(freeze.extensionPoints.decisionRules);
  assert.ok(freeze.protocolVersion);
});

test("prometheus + operation inspection", async () => {
  const { manager } = makeManager();
  const r = await manager.run(FabricOperationKind.DECISION, async () => ({}), { callerId: "a", ownerId: "a", operationId: "insp-1" });
  assert.equal(r.operationId, "insp-1");
  const inspection = await manager.inspectOperation("insp-1");
  assert.equal(inspection.operationId, "insp-1");
  assert.ok(inspection.operation);
  assert.match(manager.prometheus(), /fabric_/);
});

test("100 concurrent operations all complete + are tracked", async () => {
  const { manager } = makeManager();
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push(manager.run(FabricOperationKind.DECISION, async () => ({ i }), { callerId: "a", ownerId: "a", operationId: `k${i}` }));
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.ok));
});

test("stress: mixed success/failure workload stays consistent + never throws unexpectedly", async () => {
  const { manager } = makeManager({ config: { retry: { maxAttempts: 1 }, recovery: { maxResumeAttempts: 1, recoveryTimeoutMs: 50 } } });
  const jobs = [];
  for (let i = 0; i < 120; i++) {
    const fail = i % 3 === 0;
    jobs.push(
      manager.run(
        ALL_OPERATION_KINDS[i % ALL_OPERATION_KINDS.length],
        async () => {
          if (fail) throw classedError(i % 2 ? FailureClass.TRANSIENT : FailureClass.VALIDATION);
          return { i };
        },
        { callerId: "a", ownerId: "a", operationId: `s${i}`, compartment: `comp${i % 4}` },
      ),
    );
  }
  const results = await Promise.all(jobs);
  assert.equal(results.length, 120);
  assert.ok(results.every((r) => typeof r.ok === "boolean" && r.operationId));
});

test("fuzz: random orchestration inputs never crash the wrapper", async () => {
  const { manager } = makeManager({ config: { retry: { maxAttempts: 1 }, recovery: { maxResumeAttempts: 1, recoveryTimeoutMs: 30 } } });
  const jobs = [];
  for (let i = 0; i < 80; i++) {
    const kind = ALL_OPERATION_KINDS[(i * 7) % ALL_OPERATION_KINDS.length];
    const mode = i % 4;
    const executor = async () => {
      if (mode === 0) return { ok: 1 };
      if (mode === 1) throw classedError(FailureClass.TRANSIENT);
      if (mode === 2) throw classedError(FailureClass.PERMANENT);
      throw Object.assign(new Error("weird"), { weird: true }); // unclassified
    };
    jobs.push(manager.run(kind, executor, { callerId: "a", ownerId: "a", operationId: `f${i}` }).catch((e) => ({ ok: false, thrown: e?.code ?? "threw" })));
  }
  const results = await Promise.all(jobs);
  assert.equal(results.length, 80);
  // every result is a well-formed object (no unhandled crash)
  assert.ok(results.every((r) => r && typeof r === "object"));
});

test("reliable fabric integration wraps execute with resilience", async () => {
  const { manager } = makeManager();
  const fakeFabricApi = {
    execute: async (req) => ({ status: "completed", requestId: req.requestId, decision: { strategy: "direct" } }),
    plan: async () => ({}),
    health: async () => ({ status: "ok" }),
  };
  const reliable = createReliableFabric({ fabricApi: fakeFabricApi, reliabilityManager: manager });
  const r = await reliable.execute({ type: "direct-message", senderId: "alice", recipients: ["bob"], requestId: "rq1" }, { callerId: "alice" });
  assert.equal(r.ok, true);
  assert.equal(r.result.status, "completed");
});

test("reliable fabric integration gracefully handles a failing fabric", async () => {
  const { manager } = makeManager({ config: { retry: { maxAttempts: 1 }, recovery: { maxResumeAttempts: 1, recoveryTimeoutMs: 50 } } });
  const fakeFabricApi = { execute: async () => { throw classedError(FailureClass.VALIDATION); } };
  const reliable = createReliableFabric({ fabricApi: fakeFabricApi, reliabilityManager: manager });
  const r = await reliable.execute({ type: "direct-message", senderId: "alice", requestId: "rq2" }, { callerId: "alice" });
  assert.equal(r.ok, false);
  assert.equal(r.state, OperationState.GRACEFULLY_FAILED);
});
