import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MetricsRegistry } from "../observability/metrics.js";
import { SecurityMonitor } from "../monitoring/securityMonitor.js";
import {
  KeyLifecycleVerifier,
  findKeyMaterial,
  verifyMessageKeyLifecycle,
  verifyKeyHierarchyLifecycle,
} from "../lifecycle/lifecycleVerifier.js";
import { protocolManifest, assertCompatible, FROZEN_VERSIONS } from "../freeze/protocolFreeze.js";
import { HardeningEventBus } from "../events/events.js";
import { AlertType, AlertSeverity, HardeningEventType } from "../types/types.js";
import { makeClock, makeSessionId, captureEvents } from "./helpers.js";

describe("MetricsRegistry", () => {
  it("counters, gauges, histograms, timers + snapshot", () => {
    const clock = makeClock();
    const m = new MetricsRegistry({ clock });
    m.increment("messages", 3);
    m.gauge("sessions", 10);
    m.observe("latency_ms", 5);
    m.observe("latency_ms", 15);
    const stop = m.startTimer("op_ms");
    clock.advance(7);
    stop();
    const snap = m.snapshot();
    assert.equal(snap.counters.messages, 3);
    assert.equal(snap.gauges.sessions, 10);
    assert.equal(snap.histograms.latency_ms.count, 2);
    assert.equal(snap.histograms.latency_ms.avg, 10);
    assert.equal(snap.histograms.op_ms.max, 7);
  });

  it("renders Prometheus format + supports labels + exporter hook", () => {
    const m = new MetricsRegistry();
    m.increment("replays_total", 1, { verdict: "duplicate" });
    m.observe("enc_ms", 3);
    const text = m.prometheus();
    assert.match(text, /# TYPE replays_total counter/);
    assert.match(text, /replays_total\{verdict="duplicate"\} 1/);
    assert.match(text, /enc_ms_bucket\{le="\+Inf"\} 1/);
    let exported = null;
    m.registerExporter((snap) => (exported = snap));
    m.exportMetrics();
    assert.ok(exported.counters);
  });
});

describe("SecurityMonitor", () => {
  let events, metrics, monitor;
  beforeEach(() => {
    events = new HardeningEventBus();
    metrics = new MetricsRegistry();
    monitor = new SecurityMonitor({ events, metrics, clock: makeClock(), windowMs: 60000, thresholds: { [AlertType.SUSPICIOUS_REPLAY]: 3 } });
  });

  it("raises an alert once the threshold is crossed within the window", () => {
    const { seen } = captureEvents(events);
    const sid = makeSessionId(1);
    assert.equal(monitor.onReplayDetected({ sessionId: sid }), null);
    assert.equal(monitor.onReplayDetected({ sessionId: sid }), null);
    const alert = monitor.onReplayDetected({ sessionId: sid }); // 3rd → alert
    assert.ok(alert);
    assert.equal(alert.type, AlertType.SUSPICIOUS_REPLAY);
    assert.equal(alert.severity, AlertSeverity.WARNING);
    assert.ok(seen.types().includes(HardeningEventType.ALERT_RAISED));
    // MetricsRegistry sorts label keys alphabetically (severity before type).
    assert.equal(metrics.snapshot().counters[`security_alerts_total{severity="warning",type="${AlertType.SUSPICIOUS_REPLAY}"}`], 1);
  });

  it("critical anomalies (rollback, corruption) alert immediately per threshold", () => {
    const rollbackMonitor = new SecurityMonitor({ clock: makeClock(), thresholds: { [AlertType.GENERATION_ROLLBACK_ATTEMPT]: 1 } });
    const a = rollbackMonitor.onRollbackAttempt({ sessionId: makeSessionId(1) });
    assert.equal(a.severity, AlertSeverity.CRITICAL);
    const c = new SecurityMonitor({ clock: makeClock() }).onMetadataCorruption({ sessionId: makeSessionId(1) });
    assert.equal(c.type, AlertType.METADATA_CORRUPTION);
  });

  it("never lets key-like fields into an alert", () => {
    const alert = new SecurityMonitor({ clock: makeClock() }).onMetadataCorruption({ sessionId: "s", encryptionKey: "LEAK", note: "ok" });
    assert.equal("encryptionKey" in (alert.details ?? {}), false);
    assert.equal(alert.details.note, "ok");
  });

  it("subscribe() auto-feeds from replay events; report() summarizes", () => {
    const bus = new HardeningEventBus();
    const m = new SecurityMonitor({ clock: makeClock(), thresholds: { [AlertType.SUSPICIOUS_REPLAY]: 2 } });
    m.subscribe(bus);
    bus.emit(HardeningEventType.REPLAY_DETECTED, { sessionId: makeSessionId(1) });
    bus.emit(HardeningEventType.REPLAY_DETECTED, { sessionId: makeSessionId(1) });
    assert.equal(m.alerts.length, 1);
    assert.ok(m.report().alerts.length === 1);
  });
});

describe("KeyLifecycleVerifier", () => {
  it("findKeyMaterial deep-scans for buffers + forbidden fields", () => {
    assert.equal(findKeyMaterial({ a: { b: 1 }, list: [{ ok: true }] }).length, 0);
    assert.ok(findKeyMaterial({ nested: { encryptionKey: "x" } }).length > 0);
    assert.ok(findKeyMaterial({ k: Buffer.from("secret") }).length > 0);
  });

  it("verifies a clean message-key DTO + flags a leaked key", () => {
    const clean = { sessionId: makeSessionId(1), messages: [{ direction: "sending", messageNumber: 0, state: "used", delivery: "encrypted" }], sending: { count: 1 } };
    assert.equal(verifyMessageKeyLifecycle(clean).every((c) => c.ok), true);
    const leaked = { ...clean, secretBlob: Buffer.from("k") };
    assert.equal(verifyMessageKeyLifecycle(leaked).find((c) => c.name === "no-key-material").ok, false);
  });

  it("verifies a key-hierarchy DTO", () => {
    const dto = { sessionId: makeSessionId(1), rootKey: { rootKeyId: "r" }, sendingChain: { index: 0 }, receivingChain: { index: 0 }, archivedChains: [] };
    assert.equal(verifyKeyHierarchyLifecycle(dto).every((c) => c.ok), true);
  });

  it("verifier emits events + returns a consolidated report", () => {
    const events = new HardeningEventBus();
    const { seen } = captureEvents(events);
    const verifier = new KeyLifecycleVerifier({ events });
    const ok = verifier.verify("message-keys", { sessionId: makeSessionId(1), messages: [] });
    assert.equal(ok.ok, true);
    const bad = verifier.verify("message-keys", { sessionId: makeSessionId(1), leak: Buffer.from("x"), messages: [] });
    assert.equal(bad.ok, false);
    assert.ok(seen.types().includes(HardeningEventType.LIFECYCLE_VERIFIED));
    assert.ok(seen.types().includes(HardeningEventType.LIFECYCLE_VIOLATION));
  });
});

describe("protocol freeze", () => {
  it("exposes a manifest of frozen interfaces + extension points", () => {
    const m = protocolManifest();
    assert.equal(m.frozen, true);
    assert.ok(m.interfaces["message-keys"].includes("sealMessage/openMessage"));
    assert.ok(m.extensionPoints.some((e) => /Peer Discovery|WebRTC|P2P/.test(e.forLayer)));
  });

  it("assertCompatible flags version mismatches", () => {
    assert.equal(assertCompatible({ messageKeys: FROZEN_VERSIONS.messageKeys }).compatible, true);
    const bad = assertCompatible({ messageKeys: 999 });
    assert.equal(bad.compatible, false);
    assert.equal(bad.mismatches.length, 1);
  });
});
