/**
 * Cross-device coordination + Execution planning (optimized plan + timeline) tests (Layer 12, Sprint 3).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOptimizer, directRequest, groupRequest, mediaRequest } from "./helpers.js";
import { CrossDeviceCoordinator } from "../coordination/deviceCoordinator.js";
import { OptimizedExecutionPlanner } from "../planners/executionPlanner.js";
import { buildTimeline } from "../planners/executionTimeline.js";
import { DeviceRole, CoordinationKind, ScheduleStatus, SchedulingMode } from "../types/types.js";
import { InvalidOptimizedPlanError } from "../errors.js";

test("device coordinator selects a deterministic primary (highest score)", () => {
  const coord = new CrossDeviceCoordinator();
  const r = coord.coordinate({ userId: "alice", devices: [{ deviceId: "phone", score: 5 }, { deviceId: "laptop", score: 9 }, { deviceId: "tablet", score: 3 }], analysis: {} });
  assert.equal(r.primary, "laptop");
  assert.deepEqual(r.replicas.sort(), ["phone", "tablet"]);
  assert.equal(r.devices.find((d) => d.deviceId === "laptop").role, DeviceRole.PRIMARY);
});

test("primary selection is deterministic on ties (lowest id)", () => {
  const coord = new CrossDeviceCoordinator();
  const r = coord.coordinate({ userId: "alice", devices: [{ deviceId: "zeta", score: 5 }, { deviceId: "alpha", score: 5 }], analysis: {} });
  assert.equal(r.primary, "alpha");
});

test("coordination plan covers delivery / sync / media / execution", () => {
  const coord = new CrossDeviceCoordinator();
  const r = coord.coordinate({ userId: "alice", devices: [{ deviceId: "a", score: 1 }, { deviceId: "b", score: 2 }], analysis: { isMedia: true } });
  assert.equal(r.plan[CoordinationKind.DELIVERY].device, "b");
  assert.deepEqual(r.plan[CoordinationKind.SYNCHRONIZATION].devices.sort(), ["a", "b"]);
  assert.equal(r.plan[CoordinationKind.MEDIA].device, "b");
});

test("single-device (no devices) coordinates without replicas", () => {
  const coord = new CrossDeviceCoordinator();
  const r = coord.coordinate({ userId: "alice", devices: [], analysis: {} });
  assert.equal(r.singleDevice, true);
  assert.equal(r.replicas.length, 0);
});

test("device provider is used when devices are not passed", () => {
  const coord = new CrossDeviceCoordinator({ deviceProvider: () => [{ deviceId: "d1", score: 1 }, { deviceId: "d2", score: 2 }] });
  const r = coord.coordinate({ userId: "alice", analysis: {} });
  assert.equal(r.primary, "d2");
});

test("timeline honours dependency edges (dependent step starts after its dependency)", () => {
  const plan = {
    steps: [
      { stepId: "s1", subsystem: "media", action: "deliver-media", route: "media-pipeline", required: true, dependsOn: [] },
      { stepId: "s2", subsystem: "messaging", action: "deliver-media-ref", route: "direct-transport", required: true, dependsOn: ["s1"] },
    ],
  };
  const tl = buildTimeline(plan);
  const s1 = tl.steps.find((s) => s.stepId === "s1");
  const s2 = tl.steps.find((s) => s.stepId === "s2");
  assert.equal(s1.offsetMs, 0);
  assert.equal(s2.offsetMs, s1.offsetMs + s1.durationMs, "s2 starts after s1 finishes");
  assert.equal(s1.parallelizable, true);
  assert.equal(s2.parallelizable, false);
});

test("optimized planner assembles + validates a consistent plan", async () => {
  const { api } = makeOptimizer();
  const plan = await api.getExecutionPlan(directRequest(), { callerId: "alice" });
  assert.ok(plan.planId);
  assert.equal(plan.schedulingPlan.status, ScheduleStatus.IMMEDIATE);
  assert.ok(plan.qosPlan.qosClass);
  assert.ok(Array.isArray(plan.timeline));
  assert.ok(plan.estimatedTotalMs >= 0);
});

test("optimized planner rejects a status/proceed mismatch", () => {
  const planner = new OptimizedExecutionPlanner();
  assert.throws(
    () =>
      planner.build({
        requestId: "r",
        executionPlan: { steps: [{ stepId: "s", subsystem: "messaging", action: "deliver", route: "direct-transport", required: true, dependsOn: [] }], strategyType: "direct" },
        qos: { qosClass: "normal", lane: "normal", weight: 2 },
        scheduling: { status: ScheduleStatus.IMMEDIATE, proceed: false, mode: SchedulingMode.IMMEDIATE, lane: "normal" },
      }),
    InvalidOptimizedPlanError,
  );
});

test("media optimization yields a batch plan with a longer timeline", async () => {
  const { api } = makeOptimizer();
  const media = await api.getExecutionPlan(mediaRequest(), { callerId: "alice" });
  const direct = await api.getExecutionPlan(directRequest(), { callerId: "alice" });
  assert.equal(media.metadata.batched, true);
  assert.ok(media.estimatedTotalMs >= direct.estimatedTotalMs);
});
