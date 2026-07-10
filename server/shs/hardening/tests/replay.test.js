import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReplayCache } from "../replay/replayCache.js";
import { checkTimestamp, isFresh } from "../replay/timestampValidator.js";
import { ReplayProtector } from "../replay/replayProtector.js";
import { HardeningEventBus } from "../events/events.js";
import { ReplayReason, HardeningEventType } from "../types.js";
import { ReplayDetectedError } from "../errors.js";

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const c = () => now;
  c.advance = (ms) => (now += ms);
  return c;
}

describe("ReplayCache", () => {
  it("tracks membership with TTL expiry", () => {
    const clock = makeClock();
    const cache = new ReplayCache({ ttlMs: 1000, clock });
    assert.equal(cache.add("a"), true);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.add("a"), false); // already present
    clock.advance(1500);
    assert.equal(cache.has("a"), false); // expired
    assert.equal(cache.add("a"), true); // fresh again
  });

  it("enforces capacity with oldest-eviction + eviction hook", () => {
    const evicted = [];
    const cache = new ReplayCache({ ttlMs: 10000, maxEntries: 3, onEvict: (k, r) => evicted.push([k, r]) });
    for (const k of ["a", "b", "c", "d", "e"]) cache.add(k);
    assert.equal(cache.size, 3);
    assert.equal(cache.has("a"), false); // evicted
    assert.equal(cache.has("e"), true);
    assert.ok(evicted.some(([, r]) => r === "capacity"));
  });

  it("prune removes expired entries", () => {
    const clock = makeClock();
    const cache = new ReplayCache({ ttlMs: 1000, clock });
    cache.add("a");
    cache.add("b");
    clock.advance(2000);
    assert.equal(cache.prune(), 2);
    assert.equal(cache.size, 0);
  });
});

describe("timestamp validation", () => {
  it("accepts fresh, rejects stale + future", () => {
    const now = 1_000_000;
    assert.equal(checkTimestamp(now, { now }).ok, true);
    assert.equal(checkTimestamp(now - 200_000, { now, maxAgeMs: 120_000 }).reason, ReplayReason.STALE_TIMESTAMP);
    assert.equal(checkTimestamp(now + 60_000, { now, maxSkewMs: 30_000 }).reason, ReplayReason.FUTURE_TIMESTAMP);
    assert.equal(isFresh("bad", { now }), false);
  });
});

describe("ReplayProtector", () => {
  it("accepts once, rejects a replay, and re-accepts after TTL", () => {
    const clock = makeClock();
    const rp = new ReplayProtector({ clock, maxAgeMs: 10_000 });
    const msg = { messageId: "m1", nonce: "n1", handshakeId: "h1", timestamp: clock() };
    assert.equal(rp.accept(msg).ok, true);
    assert.throws(() => rp.accept(msg), ReplayDetectedError);
    clock.advance(11_000);
    assert.equal(rp.accept({ ...msg, timestamp: clock() }).ok, true);
  });

  it("rejects a stale/future timestamp before touching the cache", () => {
    const clock = makeClock();
    const rp = new ReplayProtector({ clock, maxAgeMs: 10_000, maxSkewMs: 5_000 });
    assert.equal(rp.check({ messageId: "m2", timestamp: clock() - 20_000 }).reason, ReplayReason.STALE_TIMESTAMP);
    assert.equal(rp.check({ messageId: "m3", timestamp: clock() + 20_000 }).reason, ReplayReason.FUTURE_TIMESTAMP);
  });

  it("detects a nonce replayed under a different messageId", () => {
    const clock = makeClock();
    const rp = new ReplayProtector({ clock });
    rp.accept({ messageId: "m1", nonce: "shared", timestamp: clock() });
    const verdict = rp.check({ messageId: "m2", nonce: "shared", timestamp: clock() });
    assert.equal(verdict.reason, ReplayReason.DUPLICATE_NONCE);
  });

  it("handshake-id first-use guard", () => {
    const rp = new ReplayProtector({ clock: makeClock() });
    assert.equal(rp.consumeHandshakeId("h1"), true);
    assert.equal(rp.consumeHandshakeId("h1"), false);
  });

  it("emits replay events", () => {
    const events = new HardeningEventBus();
    const seen = [];
    events.on(HardeningEventType.REPLAY_DETECTED, (e) => seen.push(e));
    const clock = makeClock();
    const rp = new ReplayProtector({ clock, events });
    const msg = { messageId: "m1", nonce: "n1", timestamp: clock() };
    rp.accept(msg);
    assert.throws(() => rp.accept(msg), ReplayDetectedError);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, ReplayReason.DUPLICATE_MESSAGE_ID);
  });
});
