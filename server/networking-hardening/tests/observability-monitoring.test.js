/**
 * Metrics, monitoring/alerting, freeze, security audit, and manager health tests
 * (Layer 6, Sprint 6). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeIdGen } from "./helpers.js";
import { NetworkingMetrics } from "../observability/metrics.js";
import { NetworkMonitor } from "../monitoring/networkMonitor.js";
import { NetworkingHardeningManager } from "../manager/networkingHardeningManager.js";
import { createInMemoryHardeningRepository } from "../repository/inMemoryHardeningRepository.js";
import { protocolManifest, isControlPlaneCompatible, EXTENSION_POINTS } from "../freeze/protocolFreeze.js";
import { auditNetworkingApis, normalizePagination, assertOwnership } from "../security/securityAudit.js";
import { validateAlert, assertNoSecretMaterial } from "../validators/validators.js";
import { Metric, AlertType, AlertSeverity, HealthStatus, HardeningEventType } from "../types/types.js";
import { HardeningValidationError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("metrics registry", () => {
  let clock, metrics;
  beforeEach(() => {
    clock = makeClock();
    metrics = new NetworkingMetrics({ clock: () => clock() });
  });

  it("counters, gauges, histograms + timer", () => {
    metrics.increment(Metric.DISCOVERY_TOTAL, 2);
    metrics.gauge(Metric.CONCURRENT_DISCOVERIES, 7);
    const stop = metrics.startTimer(Metric.DISCOVERY_LATENCY);
    clock.advance(15);
    stop();
    const snap = metrics.snapshot();
    assert.equal(snap.counters[Metric.DISCOVERY_TOTAL], 2);
    assert.equal(snap.gauges[Metric.CONCURRENT_DISCOVERIES], 7);
    assert.equal(snap.histograms[Metric.DISCOVERY_LATENCY].count, 1);
    assert.equal(snap.histograms[Metric.DISCOVERY_LATENCY].max, 15);
  });

  it("discovery success rate + cache hit ratio", () => {
    metrics.recordDiscovery(true);
    metrics.recordDiscovery(true);
    metrics.recordDiscovery(false);
    assert.ok(Math.abs(metrics.discoverySuccessRate() - 2 / 3) < 1e-9);
    metrics.recordCache(true);
    metrics.recordCache(false);
    assert.equal(metrics.snapshot().gauges[Metric.CACHE_HIT_RATIO], 0.5);
  });

  it("renders Prometheus exposition format + histogram buckets", () => {
    metrics.observe(Metric.NEGOTIATION_LATENCY, 3);
    const prom = metrics.prometheus();
    assert.ok(prom.includes(`# TYPE ${Metric.NEGOTIATION_LATENCY} histogram`));
    assert.ok(prom.includes(`${Metric.NEGOTIATION_LATENCY}_bucket{le="+Inf"} 1`));
    assert.ok(prom.includes(`${Metric.NEGOTIATION_LATENCY}_count 1`));
  });

  it("OTel-style exporter hook fires on flush + never throws", () => {
    let received = null;
    const off = metrics.registerExporter((snap) => { received = snap; });
    metrics.registerExporter(() => { throw new Error("bad exporter"); });
    metrics.increment(Metric.PLAN_GENERATED);
    assert.doesNotThrow(() => metrics.exportMetrics());
    assert.ok(received.counters[Metric.PLAN_GENERATED] === 1);
    off();
  });

  it("labels are low-cardinality keyed", () => {
    metrics.increment(Metric.REPOSITORY_FAILURE, 1, { op: "findById" });
    assert.equal(metrics.snapshot().counters[`${Metric.REPOSITORY_FAILURE}{op="findById"}`], 1);
  });
});

// ---------------------------------------------------------------------------
describe("network monitor + alerting", () => {
  let clock, monitor, seen;
  beforeEach(() => {
    clock = makeClock();
    seen = [];
    const events = { emit: () => {}, on: () => () => {} };
    monitor = new NetworkMonitor({ clock, idGenerator: makeIdGen(), windowMs: 1000, events: { emit: (t, p) => seen.push({ t, p }), on: () => () => {} } });
  });

  it("raises an alert only after the threshold is crossed within the window", () => {
    // repository-failure threshold is 3.
    assert.equal(monitor.onRepositoryFailure({ subsystem: "discovery" }), null);
    assert.equal(monitor.onRepositoryFailure({ subsystem: "discovery" }), null);
    const alert = monitor.onRepositoryFailure({ subsystem: "discovery" });
    assert.ok(alert);
    assert.equal(alert.alertType, AlertType.REPOSITORY_FAILURE);
    assert.equal(alert.severity, AlertSeverity.CRITICAL);
    assert.ok(seen.some((e) => e.t === HardeningEventType.ALERT_RAISED));
  });

  it("windows expire: signals older than the window do not count", () => {
    monitor.onDiscoveryFailure({ subject: "g" }); // threshold 20
    clock.advance(2000); // past the 1000ms window
    // Only fresh signals count now; a single fresh one is far below threshold.
    assert.equal(monitor.onDiscoveryFailure({ subject: "g" }), null);
    assert.equal(monitor.counts()[AlertType.DISCOVERY_FAILURE_SPIKE] ?? 0, 1);
  });

  it("health reflects alert severity", () => {
    assert.equal(monitor.health(), HealthStatus.HEALTHY);
    for (let i = 0; i < 3; i++) monitor.onRepositoryFailure({ subsystem: "x" }); // critical
    assert.equal(monitor.health(), HealthStatus.UNHEALTHY);
  });

  it("persists alerts to a sink + sanitizes context to low-cardinality scalars", () => {
    const repo = createInMemoryHardeningRepository();
    const m = new NetworkMonitor({ clock, idGenerator: makeIdGen(), windowMs: 1000, sink: repo.alerts, thresholds: { [AlertType.CACHE_FAILURE]: 1 } });
    const alert = m.onCacheFailure({ subsystem: "presence", nefarious: { huge: "object" } });
    assert.ok(alert);
    assert.equal(alert.details.nefarious, undefined); // stripped
    assert.equal(alert.details.subsystem, "presence");
  });
});

// ---------------------------------------------------------------------------
describe("protocol freeze", () => {
  it("declares frozen versions, interfaces, extension points + excludes Layer 7", () => {
    assert.equal(protocolManifest.frozen, true);
    assert.ok(protocolManifest.interfaces["peer-discovery-protocol"].length > 0);
    assert.ok(protocolManifest.doesNotImplement.includes("nat-traversal"));
    assert.ok(protocolManifest.doesNotImplement.includes("webrtc"));
    assert.ok(EXTENSION_POINTS.length >= 5);
    assert.ok(EXTENSION_POINTS.every((p) => p.module && p.seam && p.forLayer));
  });

  it("control-plane compatibility is major-version based", () => {
    assert.ok(isControlPlaneCompatible("1.5"));
    assert.ok(!isControlPlaneCompatible("2.0"));
    assert.ok(!isControlPlaneCompatible("garbage"));
  });
});

// ---------------------------------------------------------------------------
describe("security audit + API hardening", () => {
  it("audits every networking API's posture (all pass)", () => {
    const { ok, findings, groups } = auditNetworkingApis();
    assert.equal(ok, true);
    assert.deepEqual(findings, []);
    assert.ok(groups >= 5);
  });

  it("flags a group missing a required control", () => {
    const bad = auditNetworkingApis({ evil: { base: "/x", authenticated: false, publicMetadataOnly: true, enumResistant: false } });
    assert.equal(bad.ok, false);
    assert.ok(bad.findings.some((f) => f.missing === "authenticated"));
  });

  it("normalizePagination clamps + defaults", () => {
    assert.deepEqual(normalizePagination({ limit: "5", offset: "10" }), { limit: 5, offset: 10, cursor: null });
    assert.equal(normalizePagination({ limit: 99999 }, { maxLimit: 200 }).limit, 200);
    assert.equal(normalizePagination({ limit: -1 }).limit, 50);
    assert.equal(normalizePagination({ offset: -5 }).offset, 0);
  });

  it("assertOwnership gates non-owners", () => {
    assert.ok(assertOwnership({ requester: "u1" }, "u1"));
    assert.throws(() => assertOwnership({ requester: "u1" }, "intruder"), /Forbidden/);
  });

  it("validators: alert shape + no-secret invariant", () => {
    assert.throws(() => validateAlert({ alertType: "bogus" }), HardeningValidationError);
    assert.doesNotThrow(() => validateAlert({ alertType: AlertType.CACHE_FAILURE, severity: AlertSeverity.WARNING }));
    assert.throws(() => assertNoSecretMaterial({ a: { sessionKey: "x" } }), HardeningValidationError);
  });
});

// ---------------------------------------------------------------------------
describe("hardening manager — health aggregation", () => {
  it("aggregates metrics + monitor + freeze + security into a health snapshot", () => {
    const clock = makeClock();
    const repo = createInMemoryHardeningRepository();
    const mgr = new NetworkingHardeningManager({ clock, sink: repo.alerts });
    mgr.metrics.recordDiscovery(true);
    const h = mgr.health();
    assert.equal(h.status, HealthStatus.HEALTHY);
    assert.equal(h.freeze.frozen, true);
    assert.equal(h.security.ok, true);
    assert.ok(h.metrics.snapshot);
  });

  it("emits HEALTH_CHANGED when status degrades; prometheus + manifest passthrough", () => {
    const clock = makeClock();
    const seen = [];
    const mgr = new NetworkingHardeningManager({ clock });
    mgr.events.on(HardeningEventType.HEALTH_CHANGED, (e) => seen.push(e));
    for (let i = 0; i < 3; i++) mgr.monitor.onRepositoryFailure({ subsystem: "discovery" });
    const h = mgr.health();
    assert.equal(h.status, HealthStatus.UNHEALTHY);
    assert.equal(seen.length, 1);
    assert.ok(mgr.prometheus().includes("networking_"));
    assert.equal(mgr.manifest().frozen, true);
  });
});
