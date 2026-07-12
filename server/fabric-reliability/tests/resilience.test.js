/**
 * Operational resilience tests (Layer 12, Sprint 4): circuit breaker, timeout, retry + backoff, bulkhead
 * isolation, and failure classification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClock, classedError } from "./helpers.js";
import { CircuitBreaker } from "../circuit-breaker/circuitBreaker.js";
import { withTimeout, TimeoutPolicy } from "../timeout/timeout.js";
import { RetryPolicy } from "../retry/retryPolicy.js";
import { Bulkhead } from "../retry/bulkhead.js";
import { FailureClassifier } from "../retry/failureClassifier.js";
import { CircuitState, FailureClass, BackoffStrategy } from "../types/types.js";
import { OperationTimeoutError, BulkheadFullError, CircuitOpenError, RetryExhaustedError } from "../errors.js";

test("circuit breaker trips open after the failure threshold", () => {
  const clock = makeClock();
  const cb = new CircuitBreaker({ failureThreshold: 3, clock: clock.now });
  assert.equal(cb.state, CircuitState.CLOSED);
  for (let i = 0; i < 3; i++) cb.recordFailure(FailureClass.TRANSIENT);
  assert.equal(cb.state, CircuitState.OPEN);
  assert.throws(() => cb.assertPass(), CircuitOpenError);
});

test("circuit breaker recovers via half-open → closed", () => {
  const clock = makeClock();
  const cb = new CircuitBreaker({ failureThreshold: 2, successThreshold: 2, resetTimeoutMs: 1000, clock: clock.now });
  cb.recordFailure(FailureClass.TRANSIENT);
  cb.recordFailure(FailureClass.TRANSIENT);
  assert.equal(cb.state, CircuitState.OPEN);
  assert.equal(cb.canPass(), false);
  clock.advance(1001);
  assert.equal(cb.canPass(), true); // → HALF_OPEN
  assert.equal(cb.state, CircuitState.HALF_OPEN);
  cb.recordSuccess();
  cb.recordSuccess();
  assert.equal(cb.state, CircuitState.CLOSED);
});

test("a half-open trial failure re-opens the circuit", () => {
  const clock = makeClock();
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, clock: clock.now });
  cb.recordFailure(FailureClass.TIMEOUT);
  clock.advance(101);
  cb.canPass(); // → HALF_OPEN
  cb.recordFailure(FailureClass.TIMEOUT);
  assert.equal(cb.state, CircuitState.OPEN);
});

test("validation/authorization failures never trip the breaker", () => {
  const cb = new CircuitBreaker({ failureThreshold: 1 });
  cb.recordFailure(FailureClass.VALIDATION);
  cb.recordFailure(FailureClass.AUTHORIZATION);
  assert.equal(cb.state, CircuitState.CLOSED);
});

test("withTimeout rejects a slow operation", async () => {
  await assert.rejects(() => withTimeout(() => new Promise(() => {}), 15, { label: "slow" }), OperationTimeoutError);
});

test("withTimeout resolves a fast operation", async () => {
  const r = await withTimeout(async () => 42, 1000);
  assert.equal(r, 42);
});

test("TimeoutPolicy resolves per-kind timeouts", () => {
  const p = new TimeoutPolicy({ defaultMs: 100, perKind: { schedule: 5000 } });
  assert.equal(p.forKind("schedule"), 5000);
  assert.equal(p.forKind("unknown"), 100);
});

test("retry retries transient failures then succeeds", async () => {
  let calls = 0;
  const retry = new RetryPolicy({ maxAttempts: 3, sleep: async () => {} });
  const { result, attempts } = await retry.run(async () => {
    calls++;
    if (calls < 3) throw classedError(FailureClass.TRANSIENT);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("retry does NOT retry validation errors", async () => {
  let calls = 0;
  const retry = new RetryPolicy({ maxAttempts: 5, sleep: async () => {} });
  await assert.rejects(
    () =>
      retry.run(async () => {
        calls++;
        throw classedError(FailureClass.VALIDATION);
      }),
    (e) => e.failureClass === FailureClass.VALIDATION,
  );
  assert.equal(calls, 1);
});

test("retry throws RetryExhausted after max attempts on a retryable error", async () => {
  const retry = new RetryPolicy({ maxAttempts: 2, sleep: async () => {} });
  await assert.rejects(() => retry.run(async () => { throw classedError(FailureClass.TRANSIENT); }), RetryExhaustedError);
});

test("exponential backoff grows + caps", () => {
  const retry = new RetryPolicy({ strategy: BackoffStrategy.EXPONENTIAL, baseDelayMs: 100, maxDelayMs: 500 });
  assert.equal(retry.computeDelay(2), 100);
  assert.equal(retry.computeDelay(3), 200);
  assert.equal(retry.computeDelay(4), 400);
  assert.equal(retry.computeDelay(5), 500); // capped
});

test("bulkhead limits concurrency + queues excess", async () => {
  const bh = new Bulkhead({ maxConcurrent: 2, maxQueue: 10 });
  let active = 0;
  let peak = 0;
  const task = () =>
    bh.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5).unref?.());
      active--;
    });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.ok(peak <= 2, "never exceeds maxConcurrent");
});

test("bulkhead rejects when concurrency + queue are full", async () => {
  const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 0 });
  const blocker = bh.run(() => new Promise((r) => setTimeout(r, 20).unref?.()));
  await assert.rejects(() => bh.run(async () => "x"), BulkheadFullError);
  await blocker;
});

test("failure classifier maps errors to classes", () => {
  const fc = new FailureClassifier();
  assert.equal(fc.classify(classedError(FailureClass.TIMEOUT)), FailureClass.TIMEOUT);
  assert.equal(fc.classify({ status: 403 }), FailureClass.AUTHORIZATION);
  assert.equal(fc.classify({ status: 400 }), FailureClass.VALIDATION);
  assert.equal(fc.classify({ status: 503 }), FailureClass.RESOURCE);
  assert.equal(fc.classify({ code: "ECONNRESET" }), FailureClass.RESOURCE);
  assert.equal(fc.classify(new Error("mystery")), FailureClass.UNKNOWN);
});
