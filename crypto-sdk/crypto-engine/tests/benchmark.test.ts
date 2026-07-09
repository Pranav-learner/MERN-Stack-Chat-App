import { describe, it, expect } from "vitest";
import {
  benchmark,
  benchmarkSync,
  sampleMemory,
  benchmarkEncryption,
  benchmarkDecryption,
  benchmarkSigning,
  benchmarkVerification,
  BenchmarkError,
} from "../src/index.js";

// Small iteration counts — we assert result *shape*, never absolute speed.
const opts = { iterations: 20, warmup: 2 };

describe("benchmark harness", () => {
  it("benchmarkSync returns well-formed stats", () => {
    let counter = 0;
    const r = benchmarkSync(() => { counter++; }, { ...opts, label: "noop", bytesPerOp: 100 });
    expect(counter).toBe(22); // warmup + iterations
    expect(r.label).toBe("noop");
    expect(r.iterations).toBe(20);
    expect(r.opsPerSecond).toBeGreaterThan(0);
    expect(r.minMs).toBeLessThanOrEqual(r.p50Ms);
    expect(r.p50Ms).toBeLessThanOrEqual(r.maxMs);
    expect(r.throughputMiBps).toBeGreaterThan(0);
    expect(r.bytesPerOp).toBe(100);
  });

  it("async benchmark works", async () => {
    const r = await benchmark(async () => { await Promise.resolve(); }, { ...opts, label: "async" });
    expect(r.iterations).toBe(20);
    expect(r.opsPerSecond).toBeGreaterThan(0);
  });

  it("rejects invalid iteration counts", () => {
    expect(() => benchmarkSync(() => {}, { iterations: 0 })).toThrow(BenchmarkError);
  });

  it("convenience benchmarks return results", () => {
    for (const r of [
      benchmarkEncryption(256, opts),
      benchmarkDecryption(256, opts),
      benchmarkSigning(64, opts),
      benchmarkVerification(64, opts),
    ]) {
      expect(r.iterations).toBe(20);
      expect(r.opsPerSecond).toBeGreaterThan(0);
      expect(r.throughputMiBps).toBeGreaterThan(0);
    }
  });

  it("sampleMemory returns numeric fields", () => {
    const m = sampleMemory();
    expect(m.rssBytes).toBeGreaterThan(0);
    expect(m.heapUsedBytes).toBeGreaterThan(0);
  });
});
