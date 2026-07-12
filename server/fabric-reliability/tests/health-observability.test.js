/**
 * Health + observability + security tests (Layer 12, Sprint 4): health rollup + readiness/liveness,
 * metrics (counters/gauges/histograms/prometheus/otel/rates), monitor (bus → metrics, alerts, tick),
 * diagnostics, and the security validator (authz / replay / rate-limit / audit).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClock } from "./helpers.js";
import { HealthManager } from "../health/healthManager.js";
import { FabricMetrics } from "../monitoring/metrics.js";
import { FabricMonitor } from "../monitoring/monitor.js";
import { SecurityValidator } from "../validators/securityValidator.js";
import { FabricReliabilityEventBus } from "../events/events.js";
import { HealthStatus, ComponentKind, MetricName, ReliabilityEventType, AlertSeverity } from "../types/types.js";
import { UnauthorizedReliabilityError, ReplayDetectedError, RateLimitedError } from "../errors.js";

test("health rolls components up to the worst status", async () => {
  const h = new HealthManager({ clock: makeClock().now });
  h.setComponent(ComponentKind.FABRIC, HealthStatus.HEALTHY);
  h.setComponent(ComponentKind.SCHEDULER, HealthStatus.DEGRADED);
  const health = await h.check();
  assert.equal(health.status, HealthStatus.DEGRADED);
  h.setComponent(ComponentKind.REPOSITORY, HealthStatus.UNHEALTHY);
  assert.equal((await h.check()).status, HealthStatus.UNHEALTHY);
});

test("readiness fails when a component is unhealthy; liveness independent", async () => {
  const h = new HealthManager({ clock: makeClock().now });
  h.setComponent(ComponentKind.FABRIC, HealthStatus.HEALTHY);
  assert.equal((await h.readiness()).ready, true);
  h.setComponent(ComponentKind.EXECUTION, HealthStatus.UNHEALTHY);
  assert.equal((await h.readiness()).ready, false);
  assert.equal(h.liveness().live, true);
  h.setDead("fatal");
  assert.equal(h.liveness().live, false);
});

test("probes run + a throwing probe reports unhealthy", async () => {
  const h = new HealthManager({ clock: makeClock().now });
  h.registerProbe(ComponentKind.QOS, "ok", () => ({ status: HealthStatus.HEALTHY }));
  h.registerProbe(ComponentKind.ROUTING, "boom", () => {
    throw new Error("probe failed");
  });
  const health = await h.check();
  const routing = health.components.find((c) => c.component === ComponentKind.ROUTING);
  assert.equal(routing.status, HealthStatus.UNHEALTHY);
});

test("health change emits an event", async () => {
  const events = new FabricReliabilityEventBus();
  const seen = [];
  events.on(ReliabilityEventType.HEALTH_CHANGED, (e) => seen.push(e));
  const h = new HealthManager({ events, clock: makeClock().now });
  h.setComponent(ComponentKind.FABRIC, HealthStatus.HEALTHY);
  h.setComponent(ComponentKind.FABRIC, HealthStatus.DEGRADED);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].to, HealthStatus.DEGRADED);
});

test("metrics record counters/gauges/histograms + rate", () => {
  const m = new FabricMetrics({ clock: makeClock().now });
  m.recordOperation("decision", { ok: true, latencyMs: 10 });
  m.recordOperation("decision", { ok: false, latencyMs: 20, failureClass: "transient" });
  m.recordQoS("critical");
  m.setQueueDepth(42);
  const snap = m.snapshot();
  assert.ok(snap.gauges[MetricName.EXECUTION_SUCCESS_RATE] <= 1);
  assert.equal(snap.gauges[`${MetricName.QUEUE_DEPTH}{lane=total}`], 42);
  assert.ok(snap.histograms[`${MetricName.OPERATION_LATENCY}{kind=decision}`].count === 2);
});

test("metrics export as Prometheus + OTel", () => {
  const m = new FabricMetrics({ clock: makeClock().now });
  m.recordDecisionLatency(5);
  m.incr(MetricName.COMMUNICATION_THROUGHPUT, 1, { kind: "request" });
  const prom = m.prometheus();
  assert.match(prom, /fabric_communication_throughput_total\{kind="request"\} 1/);
  const otel = m.otel();
  assert.ok(otel.some((x) => x.type === "counter"));
  assert.ok(otel.some((x) => x.type === "histogram"));
});

test("structured logging goes through the injected sink", () => {
  const logs = [];
  const m = new FabricMetrics({ clock: makeClock().now, logger: (r) => logs.push(r) });
  m.log("info", "test-event", { foo: "bar" });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "test-event");
});

test("monitor turns bus events into metrics + alerts", async () => {
  const clock = makeClock();
  const events = new FabricReliabilityEventBus();
  const metrics = new FabricMetrics({ clock: clock.now });
  const health = new HealthManager({ clock: clock.now });
  const monitor = new FabricMonitor({ metrics, health, events, clock: clock.now });
  const lower = new FabricReliabilityEventBus();
  monitor.attachBus(lower);
  lower.emit("optimization.qos_evaluated", { qosClass: "high" });
  lower.emit("optimization.workload_balanced", { totalDepth: 7 });
  const snap = metrics.snapshot();
  assert.equal(snap.gauges[`${MetricName.QUEUE_DEPTH}{lane=total}`], 7);
  assert.ok(snap.counters[`${MetricName.QOS_DISTRIBUTION}{class=high}`] >= 1);
  // circuit-opened → alert
  monitor._observe({ type: ReliabilityEventType.CIRCUIT_OPENED, name: "decision:messaging" });
  assert.ok(monitor.alerts().some((a) => a.code === "circuit-opened"));
});

test("security validator authorizes, blocks replay + rate limits", () => {
  const clock = makeClock();
  const sv = new SecurityValidator({ clock: clock.now });
  assert.doesNotThrow(() => sv.validate({ kind: "decision", operationId: "o1", callerId: "alice", ownerId: "alice" }));
  assert.throws(() => sv.validate({ kind: "decision", operationId: "o2", callerId: "mallory", ownerId: "alice" }), UnauthorizedReliabilityError);
  // replay
  sv.validate({ kind: "decision", operationId: "o3", callerId: "alice", ownerId: "alice", idempotencyKey: "k1" });
  assert.throws(() => sv.validate({ kind: "decision", operationId: "o4", callerId: "alice", ownerId: "alice", idempotencyKey: "k1" }), ReplayDetectedError);
  // rate limit
  const sv2 = new SecurityValidator({ clock: clock.now, rateLimiter: () => false });
  assert.throws(() => sv2.validate({ kind: "decision", operationId: "o5", callerId: "alice", ownerId: "alice" }), RateLimitedError);
});
