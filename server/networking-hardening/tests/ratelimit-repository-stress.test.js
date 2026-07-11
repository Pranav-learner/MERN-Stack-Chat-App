/**
 * Rate limiter, circuit breaker, resilient repository, plus large-scale LOAD/STRESS simulation and
 * FUZZ testing of hardening inputs (Layer 6, Sprint 6). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, noSleep, flakyRepo } from "./helpers.js";
import { RateLimiter, uniformNotFound, areResponsesUniform } from "../ratelimit/rateLimiter.js";
import { CircuitBreaker, wrapRepository } from "../repository/resilientRepository.js";
import { NetworkingMetrics } from "../observability/metrics.js";
import { NetworkMonitor } from "../monitoring/networkMonitor.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { IdempotencyStore, resolveConflict } from "../consistency/consistency.js";
import { validateAlert, assertNoSecretMaterial } from "../validators/validators.js";
import { normalizePagination } from "../security/securityAudit.js";
import { CircuitState, Metric, RecoveryKind } from "../types/types.js";
import { RateLimitedError, CircuitOpenError, HardeningError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("rate limiter", () => {
  let clock, limiter;
  beforeEach(() => {
    clock = makeClock();
    limiter = new RateLimiter({ capacity: 5, refillPerSec: 1, clock });
  });

  it("allows a burst up to capacity, then blocks with retryAfter", () => {
    for (let i = 0; i < 5; i++) assert.doesNotThrow(() => limiter.consume("u1"));
    const err = (() => { try { limiter.consume("u1"); } catch (e) { return e; } })();
    assert.ok(err instanceof RateLimitedError);
    assert.ok(err.retryAfterMs > 0);
    assert.equal(err.status, 429);
  });

  it("refills over time", () => {
    for (let i = 0; i < 5; i++) limiter.consume("u1");
    assert.equal(limiter.check("u1").allowed, false);
    clock.advance(3000); // +3 tokens
    assert.equal(limiter.check("u1").allowed, true);
    assert.doesNotThrow(() => limiter.consume("u1", 3));
  });

  it("isolates subjects", () => {
    for (let i = 0; i < 5; i++) limiter.consume("u1");
    assert.doesNotThrow(() => limiter.consume("u2"));
  });

  it("enumeration resistance: unknown + unauthorized responses are uniform", () => {
    const unknown = uniformNotFound();
    const unauthorized = uniformNotFound();
    assert.ok(areResponsesUniform(unknown, unauthorized));
    assert.equal(unknown.status, 404);
  });
});

// ---------------------------------------------------------------------------
describe("circuit breaker + resilient repository", () => {
  it("opens after the failure threshold, fast-fails, then half-opens after cooldown", async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ clock, failureThreshold: 3, cooldownMs: 1000, halfOpenMax: 1 });
    const boom = async () => { throw new Error("down"); };
    for (let i = 0; i < 3; i++) await breaker.exec(boom).catch(() => {});
    assert.equal(breaker.state, CircuitState.OPEN);
    await assert.rejects(() => breaker.exec(async () => "x"), CircuitOpenError); // fast-fail
    clock.advance(1000);
    assert.equal(breaker.state, CircuitState.HALF_OPEN);
    await breaker.exec(async () => "recovered"); // success closes it
    assert.equal(breaker.state, CircuitState.CLOSED);
  });

  it("wrapRepository retries transient failures + times operations", async () => {
    const clock = makeClock();
    const metrics = new NetworkingMetrics({ clock: () => clock() });
    const repo = flakyRepo(2); // fails twice, then succeeds
    const hardened = wrapRepository(repo, { clock: () => clock(), sleep: noSleep, metrics, retryPolicy: { maxAttempts: 3 } });
    const got = await hardened.findById("r1");
    assert.equal(got.ok, true);
    assert.equal(repo.calls(), 3); // 2 fails + 1 success
    assert.ok(metrics.snapshot().histograms[`${Metric.REPOSITORY_LATENCY}{op="findById"}`].count >= 1);
  });

  it("wrapRepository surfaces the circuit-open error + records failure metrics", async () => {
    const clock = makeClock();
    const metrics = new NetworkingMetrics({ clock: () => clock() });
    const alwaysDown = { async findById() { throw new Error("down"); } };
    const hardened = wrapRepository(alwaysDown, { clock: () => clock(), sleep: noSleep, metrics, retryPolicy: { maxAttempts: 1 }, circuit: { failureThreshold: 2, cooldownMs: 5000 } });
    for (let i = 0; i < 2; i++) await hardened.findById("x").catch(() => {});
    await assert.rejects(() => hardened.findById("x"), CircuitOpenError);
    assert.ok(metrics.snapshot().counters[`${Metric.REPOSITORY_FAILURE}{op="findById"}`] >= 2);
  });
});

// ---------------------------------------------------------------------------
describe("LOAD/STRESS — high-volume simulation", () => {
  it("processes 100k simulated discovery signals through metrics + monitor under budget", () => {
    const clock = makeClock();
    const metrics = new NetworkingMetrics({ clock: () => clock() });
    const monitor = new NetworkMonitor({ clock, windowMs: 60_000 });
    const start = process.hrtime.bigint();
    let alerts = 0;
    for (let i = 0; i < 100_000; i++) {
      const success = i % 7 !== 0; // ~14% failure
      metrics.recordDiscovery(success);
      metrics.recordCache(i % 3 === 0);
      if (!success && monitor.onDiscoveryFailure({ subject: `u${i % 500}` })) alerts++;
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 3000, `100k signals took ${ms}ms`);
    assert.equal(metrics.snapshot().counters[Metric.DISCOVERY_TOTAL], 100_000);
    assert.ok(metrics.discoverySuccessRate() > 0.8 && metrics.discoverySuccessRate() < 0.9);
    assert.ok(alerts > 0); // failure spikes alerted
  });

  it("rate limiter withstands 50k checks across 1000 subjects", () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ capacity: 60, refillPerSec: 30, clock });
    const start = process.hrtime.bigint();
    let blocked = 0;
    for (let i = 0; i < 50_000; i++) {
      try { limiter.consume(`discover:u${i % 1000}`); } catch { blocked++; }
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 2000, `50k rate-limit checks took ${ms}ms`);
    assert.ok(limiter.size <= 1000);
  });

  it("idempotency store coalesces a storm of duplicate requests to one execution", async () => {
    const store = new IdempotencyStore({ clock: makeClock() });
    let ran = 0;
    await Promise.all(Array.from({ length: 5000 }, () => store.run("hot-key", async () => { ran++; return "v"; })));
    assert.equal(ran, 1);
  });
});

// ---------------------------------------------------------------------------
describe("FUZZ — malformed inputs never crash the hardening layer", () => {
  const clock = makeClock();

  /** A deterministic PRNG (no Math.random → reproducible fuzz corpus). */
  function* corpus(n) {
    let s = 12345;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const junk = [null, undefined, 0, NaN, Infinity, "", "x".repeat(1000), [], {}, { a: { b: [1, 2] } }, true, () => {}, Symbol("s"), { version: "not-a-number" }, { privateKey: "leak" }];
    for (let i = 0; i < n; i++) {
      const pick = junk[Math.floor(rand() * junk.length)];
      yield rand() < 0.5 ? pick : { alertType: rand() < 0.5 ? "bogus" : undefined, severity: pick, details: pick, version: Math.floor(rand() * 10), updatedAt: pick };
    }
  }

  it("validateAlert only ever throws a typed HardeningError", () => {
    for (const input of corpus(500)) {
      try {
        validateAlert(input);
      } catch (e) {
        assert.ok(e instanceof HardeningError, `unexpected error for ${JSON.stringify(input)?.slice(0, 40)}: ${e}`);
      }
    }
  });

  it("assertNoSecretMaterial never crashes + catches planted secrets", () => {
    for (const input of corpus(500)) {
      try {
        assertNoSecretMaterial(input);
      } catch (e) {
        assert.ok(e instanceof HardeningError);
      }
    }
    assert.throws(() => assertNoSecretMaterial({ deep: [{ nested: { chainKey: "x" } }] }), HardeningError);
  });

  it("normalizePagination always returns bounded, sane values", () => {
    for (const input of corpus(500)) {
      const page = normalizePagination(typeof input === "object" && input ? input : {});
      assert.ok(Number.isInteger(page.limit) && page.limit >= 1 && page.limit <= 200);
      assert.ok(Number.isInteger(page.offset) && page.offset >= 0);
    }
  });

  it("resolveConflict is total (never throws) for arbitrary record pairs", () => {
    const inputs = [...corpus(200)];
    for (let i = 0; i < inputs.length - 1; i++) {
      const out = resolveConflict(inputs[i] ?? {}, inputs[i + 1] ?? {});
      assert.ok(out.winner !== undefined && out.reason);
    }
  });

  it("recovery coordinator handles unknown failure kinds without crashing", async () => {
    const recovery = new RecoveryCoordinator({ sleep: noSleep });
    await assert.rejects(() => recovery.recover({ kind: "totally-unknown-kind" }), (e) => e instanceof HardeningError || e.name === "UnrecoverableError");
    // A known recoverable kind with no hook is a benign no-op success.
    const out = await recovery.recover({ kind: RecoveryKind.CACHE_CORRUPTION });
    assert.equal(out.recovered, true);
  });
});
