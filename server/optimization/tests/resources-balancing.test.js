/**
 * Global Resource Manager + Workload Balancing + adaptive resource policy tests (Layer 12, Sprint 3).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOptimizer, makeClock, directRequest, mediaRequest } from "./helpers.js";
import { GlobalResourceManager } from "../resources/resourceManager.js";
import { WorkloadBalancer } from "../balancing/workloadBalancer.js";
import { estimateCost } from "../resources/costEstimator.js";
import { ContextBuilder, normalizeCommunicationRequest } from "../_fabric.js";
import { BackpressureSignal, QoSClass, SchedulingMode } from "../types/types.js";
import { InvalidResourcePlanError } from "../errors.js";

const ctx = (req) => new ContextBuilder({ clock: makeClock().now }).build(normalizeCommunicationRequest(req));

test("resource manager tracks allocate / release / snapshot", () => {
  const rm = new GlobalResourceManager({ budgets: { bandwidth: 1000, execution: 4 } });
  rm.allocate("r1", { bandwidth: 400, execution: 1 });
  let snap = rm.snapshot();
  assert.equal(snap.budgets.bandwidth.allocated, 400);
  assert.equal(snap.budgets.execution.available, 3);
  rm.release("r1");
  snap = rm.snapshot();
  assert.equal(snap.budgets.bandwidth.allocated, 0);
});

test("recommend flags a resource that does not fit", () => {
  const rm = new GlobalResourceManager({ budgets: { bandwidth: 100 } });
  const rec = rm.recommend({ bandwidth: 500 });
  assert.equal(rec.grantable, false);
  assert.ok(rec.constrained.includes("bandwidth"));
  assert.equal(rec.recommended.bandwidth, 100, "throttled to available");
});

test("a resource crosses the constrained threshold at high utilization", () => {
  const rm = new GlobalResourceManager({ budgets: { execution: 10 } });
  rm.allocate("r", { execution: 10 });
  assert.ok(rm.snapshot().constrained.includes("execution"));
});

test("cost estimation scales with payload size + media", () => {
  const small = estimateCost(ctx(directRequest()));
  const big = estimateCost(ctx(mediaRequest()));
  assert.ok(big.bandwidth > small.bandwidth);
  assert.ok(big.transfer > small.transfer);
  assert.ok(big.storage > 0);
});

test("cost override wins per-field", () => {
  const cost = estimateCost(ctx(directRequest()), { bandwidth: 9999 });
  assert.equal(cost.bandwidth, 9999);
});

test("allocate requires a requestId", () => {
  const rm = new GlobalResourceManager();
  assert.throws(() => rm.allocate(null, { bandwidth: 1 }), InvalidResourcePlanError);
});

test("workload balancer raises graded backpressure", () => {
  const balancer = new WorkloadBalancer();
  const noPressure = balancer.balance({ lanes: { critical: { depth: 0, capacity: 100 }, high: { depth: 1, capacity: 100 }, normal: { depth: 1, capacity: 100 }, background: { depth: 1, capacity: 100 } } }, { constrained: [] });
  assert.equal(noPressure.backpressure, BackpressureSignal.NONE);

  const bandwidthPressure = balancer.balance({ lanes: { normal: { depth: 1, capacity: 100 } } }, { constrained: ["bandwidth"] });
  assert.equal(bandwidthPressure.backpressure, BackpressureSignal.THROTTLE_BACKGROUND);

  const memoryPressure = balancer.balance({ lanes: { normal: { depth: 1, capacity: 100 } } }, { constrained: ["memory"] });
  assert.equal(memoryPressure.backpressure, BackpressureSignal.SHED);
});

test("admission: critical is always admitted; background throttled under pressure", () => {
  const balancer = new WorkloadBalancer();
  assert.equal(balancer.admit(QoSClass.CRITICAL, BackpressureSignal.SHED).accept, true);
  const bg = balancer.admit(QoSClass.BACKGROUND, BackpressureSignal.THROTTLE_BACKGROUND);
  assert.equal(bg.defer, true);
  assert.equal(balancer.admit(QoSClass.NORMAL, BackpressureSignal.SHED).accept, false);
});

test("distribute splits heavy (media) work sequential from light parallel", () => {
  const balancer = new WorkloadBalancer();
  const { parallel, sequential } = balancer.distribute([
    { requestId: "a", analysis: { isMedia: false }, cost: { connection: 1 } },
    { requestId: "b", analysis: { isMedia: true }, cost: { connection: 1 } },
  ]);
  assert.deepEqual(parallel.map((x) => x.requestId), ["a"]);
  assert.deepEqual(sequential.map((x) => x.requestId), ["b"]);
});

test("battery-saver resource policy backgrounds non-urgent traffic", async () => {
  const { api } = makeOptimizer({ config: { policyConfig: { battery: { enabled: true } } } });
  const r = await api.schedule(directRequest(), { callerId: "alice" });
  assert.equal(r.qos.mode, SchedulingMode.BACKGROUND);
});

test("enterprise resource policy can deny a communication class", async () => {
  const { api } = makeOptimizer({ config: { policyConfig: { enterprise: { denyClasses: ["direct-message"] } } } });
  await assert.rejects(() => api.schedule(directRequest(), { callerId: "alice" }), /denied by policy/);
});
