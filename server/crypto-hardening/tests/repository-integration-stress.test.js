import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryHardeningRepository } from "../repository/inMemoryHardeningRepository.js";
import { ReplayGuard } from "../replay/replayGuard.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { HardeningEventBus } from "../events/events.js";
import { SecurityMonitor } from "../monitoring/securityMonitor.js";
import { KeyLifecycleVerifier } from "../lifecycle/lifecycleVerifier.js";
import { ReplayVerdict } from "../types/types.js";
import { HardeningValidationError } from "../errors.js";
import { makeClock, makeSessionId } from "./helpers.js";
// Real Sprint 5 stack (specific-file imports avoid mongoose).
import { makePair } from "../../message-keys/tests/helpers.js";

describe("hardening repository — in-memory contract", () => {
  it("records + lists alerts (newest first), by session, bounded", async () => {
    const { alerts: repo, reset } = createInMemoryHardeningRepository({ max: 3 });
    for (let i = 0; i < 5; i++) await repo.record({ alertId: `a${i}`, type: "x", severity: "info", sessionId: makeSessionId(i % 2), at: new Date().toISOString() });
    assert.equal(await repo.count(), 3, "bounded to max");
    const list = await repo.list({ limit: 2 });
    assert.equal(list.length, 2);
    assert.equal(list[0].alertId, "a4", "newest first");
    const bySession = await repo.listBySession(makeSessionId(0));
    assert.ok(bySession.every((a) => a.sessionId === makeSessionId(0)));
    reset();
    assert.equal(await repo.count(), 0);
  });
});

describe("fuzz — malformed replay contexts never crash the guard", () => {
  it("handles random + malformed inputs (throws typed errors, never hangs)", () => {
    const guard = new ReplayGuard({ clock: makeClock() });
    const sid = makeSessionId(1);
    let accepted = 0;
    let rejected = 0;
    let validationErrors = 0;
    for (let i = 0; i < 2000; i++) {
      const roll = i % 7;
      let ctx;
      if (roll === 0) ctx = { sessionId: sid, generation: 0, messageNumber: i };
      else if (roll === 1) ctx = { sessionId: sid, generation: 0, messageNumber: -1 }; // malformed
      else if (roll === 2) ctx = { sessionId: "bad", generation: 0, messageNumber: 0 }; // malformed id
      else if (roll === 3) ctx = { sessionId: sid, generation: -5, messageNumber: 0 }; // malformed gen
      else if (roll === 4) ctx = null; // malformed
      else if (roll === 5) ctx = { sessionId: sid, generation: Math.floor(i / 100), messageNumber: i % 100 };
      else ctx = { sessionId: sid, generation: 0, messageNumber: i, nonce: `n${i}` };
      try {
        const r = guard.accept(ctx);
        r.ok ? accepted++ : rejected++;
      } catch (e) {
        assert.ok(e instanceof HardeningValidationError, "only typed validation errors");
        validationErrors++;
      }
    }
    assert.ok(accepted > 0 && validationErrors > 0);
    assert.ok(guard.size >= 1);
  });
});

describe("long-running + stress", () => {
  it("guard tracks 20k sequential messages with a bounded window", () => {
    const guard = new ReplayGuard({ clock: makeClock(), windowSize: 1024 });
    const sid = makeSessionId(1);
    for (let i = 0; i < 20000; i++) assert.equal(guard.accept({ sessionId: sid, generation: 0, messageNumber: i }).ok, true);
    const status = guard.status(sid);
    assert.equal(status.highWater, 19999);
    assert.ok(status.tracked <= 1024, "replay window is bounded");
    // a very old message (far below the window) is refused as out-of-window
    assert.equal(guard.accept({ sessionId: sid, generation: 0, messageNumber: 0 }).verdict, ReplayVerdict.OUT_OF_WINDOW);
  });

  it("metrics + monitor stay consistent under a burst of replays", () => {
    const events = new HardeningEventBus();
    const metrics = new MetricsRegistry();
    const guard = new ReplayGuard({ events, metrics, clock: makeClock() });
    const monitor = new SecurityMonitor({ events, metrics, clock: makeClock(), thresholds: { "suspicious-replay": 5 } });
    monitor.subscribe(events);
    const sid = makeSessionId(1);
    guard.accept({ sessionId: sid, generation: 0, messageNumber: 0 });
    for (let i = 0; i < 10; i++) guard.accept({ sessionId: sid, generation: 0, messageNumber: 0 }); // replays
    assert.ok(metrics.snapshot().counters['replay_rejected_total{verdict="duplicate-message"}'] >= 10);
    assert.ok(monitor.alerts.length >= 1, "monitor raised a suspicious-replay alert");
  });
});

describe("end-to-end integration — hardening over the real message pipeline (Sprint 5)", () => {
  it("replay guard rejects a re-delivered envelope before it reaches decryption", async () => {
    const { alice, bob, sessionId } = await makePair(1);
    const guard = new ReplayGuard({ clock: makeClock() });

    const e0 = await alice.transport.encrypt({ n: 0 }, { sessionId });
    // bob's inbound path: guard first, then decrypt
    assert.equal(guard.accept({ sessionId, generation: e0.generation, messageNumber: e0.messageNumber }).ok, true);
    assert.deepEqual(await bob.transport.decrypt(e0, { sessionId }), { n: 0 });

    // an attacker re-injects e0 → the guard rejects it up-front (defence-in-depth)
    const replay = guard.accept({ sessionId, generation: e0.generation, messageNumber: e0.messageNumber });
    assert.equal(replay.ok, false);
    assert.equal(replay.verdict, ReplayVerdict.DUPLICATE_MESSAGE);
  });

  it("lifecycle verifier confirms no key material leaks from real DTOs", async () => {
    const { alice, sessionId } = await makePair(2);
    await alice.transport.encrypt({ hi: 1 }, { sessionId });
    const verifier = new KeyLifecycleVerifier();
    const mkDto = await alice.manager.getState(sessionId);
    const khDto = await alice.chains.getState(sessionId);
    assert.equal(verifier.verify("message-keys", mkDto).ok, true);
    assert.equal(verifier.verify("key-hierarchy", khDto).ok, true);
  });
});
