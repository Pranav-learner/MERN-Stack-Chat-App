import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RetryPolicy, BackoffStrategy } from "../retry/retry.js";
import { TimeoutScheduler, deadlineFrom, isElapsed, remainingMs } from "../timeout/timeout.js";

describe("RetryPolicy", () => {
  it("honours the retry budget", () => {
    const p = new RetryPolicy({ maxRetries: 3 });
    assert.equal(p.canRetry(0), true);
    assert.equal(p.canRetry(2), true);
    assert.equal(p.canRetry(3), false);
    assert.equal(p.remaining(1), 2);
    assert.equal(p.remaining(5), 0);
  });

  it("exponential backoff doubles and caps", () => {
    const p = new RetryPolicy({ strategy: BackoffStrategy.EXPONENTIAL, baseMs: 500, maxDelayMs: 3000 });
    assert.equal(p.nextDelay(0), 500);
    assert.equal(p.nextDelay(1), 1000);
    assert.equal(p.nextDelay(2), 2000);
    assert.equal(p.nextDelay(3), 3000); // capped (would be 4000)
    assert.equal(p.nextDelay(10), 3000);
  });

  it("fixed and linear strategies", () => {
    assert.equal(new RetryPolicy({ strategy: BackoffStrategy.FIXED, baseMs: 250 }).nextDelay(5), 250);
    const lin = new RetryPolicy({ strategy: BackoffStrategy.LINEAR, baseMs: 100 });
    assert.equal(lin.nextDelay(0), 100);
    assert.equal(lin.nextDelay(2), 300);
  });

  it("jitter reduces the delay within bounds and is deterministic when injected", () => {
    const p = new RetryPolicy({ strategy: BackoffStrategy.FIXED, baseMs: 1000, jitterRatio: 0.5, random: () => 1 });
    // reduction = 1000 * 0.5 * 1 = 500 → 500
    assert.equal(p.nextDelay(0), 500);
    const p2 = new RetryPolicy({ strategy: BackoffStrategy.FIXED, baseMs: 1000, jitterRatio: 0.5, random: () => 0 });
    assert.equal(p2.nextDelay(0), 1000);
  });

  it("describe() is serializable", () => {
    const d = new RetryPolicy().describe();
    assert.ok(d.maxRetries >= 0 && d.strategy && d.baseMs >= 0);
  });
});

describe("timeout math", () => {
  it("computes deadlines / elapsed / remaining", () => {
    assert.equal(deadlineFrom(1000, 500), 1500);
    assert.equal(isElapsed(1500, 1600), true);
    assert.equal(isElapsed(1500, 1400), false);
    assert.equal(remainingMs(1500, 1400), 100);
    assert.equal(remainingMs(1500, 1600), 0);
  });
});

describe("TimeoutScheduler (injected timers)", () => {
  function fakeTimers() {
    let seq = 0;
    const pending = new Map();
    return {
      setTimer: (fn, ms) => {
        const id = ++seq;
        pending.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => pending.delete(id),
      fire: (id) => {
        const t = pending.get(id);
        pending.delete(id);
        t.fn();
      },
      pending,
    };
  }

  it("fires the callback on elapse and clears itself", () => {
    const timers = fakeTimers();
    const fired = [];
    const sched = new TimeoutScheduler({
      onTimeout: (id, meta) => fired.push({ id, meta }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    sched.arm("hs-1", 100, { step: "await-accept" });
    assert.equal(sched.has("hs-1"), true);
    assert.equal(sched.size, 1);
    // Fire the underlying timer (id 1).
    timers.fire(1);
    assert.deepEqual(fired, [{ id: "hs-1", meta: { step: "await-accept" } }]);
    assert.equal(sched.has("hs-1"), false);
  });

  it("clear() cancels a pending timeout", () => {
    const timers = fakeTimers();
    const fired = [];
    const sched = new TimeoutScheduler({ onTimeout: (id) => fired.push(id), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    sched.arm("hs-1", 100);
    assert.equal(sched.clear("hs-1"), true);
    assert.equal(sched.clear("hs-1"), false);
    assert.equal(timers.pending.size, 0);
    assert.equal(fired.length, 0);
  });

  it("re-arming replaces the previous timer", () => {
    const timers = fakeTimers();
    const sched = new TimeoutScheduler({ onTimeout: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    sched.arm("hs-1", 100);
    sched.arm("hs-1", 200);
    assert.equal(sched.size, 1);
    assert.equal(timers.pending.size, 1); // old one cleared
    sched.clearAll();
    assert.equal(sched.size, 0);
  });
});
