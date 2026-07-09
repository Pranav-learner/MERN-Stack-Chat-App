import { describe, it, expect } from "vitest";
import {
  AgeBasedRotationPolicy,
  UsageBasedRotationPolicy,
  ExpiryRotationPolicy,
  NeverRotatePolicy,
  ManualRotationPolicy,
  CompositeRotationPolicy,
  RotationScheduler,
  NoopSchedulerDriver,
  buildHistoryChain,
  toIso,
} from "../src/index.js";
import { makeIdentityKey } from "./helpers.js";

describe("rotation policies", () => {
  const now = 1_000_000;

  it("NeverRotatePolicy / ManualRotationPolicy never fire", () => {
    const key = makeIdentityKey();
    expect(new NeverRotatePolicy().shouldRotate(key)).toBe(false);
    expect(new ManualRotationPolicy().shouldRotate(key)).toBe(false);
  });

  it("AgeBasedRotationPolicy fires past maxAge", () => {
    const key = makeIdentityKey().withMetadata({ createdAt: toIso(now - 5000) });
    expect(new AgeBasedRotationPolicy(4000).shouldRotate(key, { now })).toBe(true);
    expect(new AgeBasedRotationPolicy(6000).shouldRotate(key, { now })).toBe(false);
  });

  it("UsageBasedRotationPolicy reads context or custom metadata", () => {
    const policy = new UsageBasedRotationPolicy(10);
    expect(policy.shouldRotate(makeIdentityKey(), { usageCount: 10 })).toBe(true);
    expect(policy.shouldRotate(makeIdentityKey(), { usageCount: 9 })).toBe(false);
    const withUsage = makeIdentityKey().withMetadata({ custom: { usageCount: 12 } });
    expect(policy.shouldRotate(withUsage)).toBe(true);
  });

  it("ExpiryRotationPolicy fires for expired keys", () => {
    const key = makeIdentityKey().withMetadata({ expiresAt: toIso(now - 1) });
    expect(new ExpiryRotationPolicy().shouldRotate(key, { now })).toBe(true);
  });

  it("CompositeRotationPolicy supports any/all", () => {
    const key = makeIdentityKey().withMetadata({ createdAt: toIso(now - 5000) });
    const age = new AgeBasedRotationPolicy(4000);
    const usage = new UsageBasedRotationPolicy(10);
    expect(new CompositeRotationPolicy([age, usage], "any").shouldRotate(key, { now })).toBe(true);
    expect(new CompositeRotationPolicy([age, usage], "all").shouldRotate(key, { now, usageCount: 0 })).toBe(false);
    expect(new CompositeRotationPolicy([age, usage], "all").shouldRotate(key, { now, usageCount: 10 })).toBe(true);
  });

  it("rejects invalid policy parameters", () => {
    expect(() => new AgeBasedRotationPolicy(0)).toThrow(RangeError);
    expect(() => new UsageBasedRotationPolicy(-1)).toThrow(RangeError);
    expect(() => new CompositeRotationPolicy([])).toThrow(RangeError);
  });
});

describe("RotationScheduler (pure evaluation, no auto-rotation)", () => {
  it("reports decisions without mutating keys", () => {
    const now = 1_000_000;
    const keys = [
      makeIdentityKey("o", "a").withMetadata({ createdAt: toIso(now - 10_000) }),
      makeIdentityKey("o", "b").withMetadata({ createdAt: toIso(now - 100) }),
    ];
    const decisions = new RotationScheduler().evaluate(keys, new AgeBasedRotationPolicy(5000), { now });
    expect(decisions.find((d) => d.keyId === "a")?.shouldRotate).toBe(true);
    expect(decisions.find((d) => d.keyId === "b")?.shouldRotate).toBe(false);
    expect(decisions[0]?.policy).toBe("age-based");
  });
});

describe("NoopSchedulerDriver", () => {
  it("tracks running state without doing anything", () => {
    const d = new NoopSchedulerDriver();
    expect(d.running).toBe(false);
    d.start();
    expect(d.running).toBe(true);
    d.stop();
    expect(d.running).toBe(false);
  });
});

describe("buildHistoryChain", () => {
  it("reconstructs lineage oldest-first", () => {
    const v1 = makeIdentityKey("o", "v1");
    const v2 = makeIdentityKey("o", "v2").withMetadata({ version: 2, previousKeyId: "v1" });
    const v3 = makeIdentityKey("o", "v3").withMetadata({ version: 3, previousKeyId: "v2" });
    const map = new Map([
      ["v1", v1],
      ["v2", v2],
      ["v3", v3],
    ]);
    const chain = buildHistoryChain("v3", map);
    expect(chain.map((c) => c.keyId)).toEqual(["v1", "v2", "v3"]);
    expect(chain.map((c) => c.version)).toEqual([1, 2, 3]);
  });
});
