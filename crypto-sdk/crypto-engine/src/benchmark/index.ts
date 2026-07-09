/**
 * @module benchmark
 *
 * Reusable micro-benchmark harness for the engine's operations. Measures latency
 * distribution, throughput, and memory. Uses `performance.now()` for timing.
 *
 * These are diagnostic utilities — results are environment-dependent and NOT part
 * of any correctness contract. Tests assert only that results are well-formed.
 */

import { performance } from "node:perf_hooks";
import {
  SymmetricKey,
  decrypt,
  encrypt,
  generateSigningKeyPair,
  randomBytes,
  sign,
  verify,
} from "@securechat/crypto-sdk";
import type { BenchmarkResult, MemorySample } from "../types/index.js";
import { BenchmarkError } from "../errors/index.js";

/** Options for a benchmark run. */
export interface BenchmarkOptions {
  /** Measured iterations (default 1000). */
  iterations?: number;
  /** Warm-up iterations excluded from stats (default 50). */
  warmup?: number;
  /** Label for the result (default `"benchmark"`). */
  label?: string;
  /** Bytes processed per op, to compute throughput. */
  bytesPerOp?: number;
}

function summarize(label: string, samples: number[], bytesPerOp?: number): BenchmarkResult {
  if (samples.length === 0) throw new BenchmarkError("No samples collected");
  const sorted = [...samples].sort((a, b) => a - b);
  const totalMs = samples.reduce((s, x) => s + x, 0);
  const meanMs = totalMs / samples.length;
  const pct = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  const opsPerSecond = meanMs > 0 ? 1000 / meanMs : Infinity;
  const result: BenchmarkResult = {
    label,
    iterations: samples.length,
    totalMs,
    meanMs,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    p50Ms: pct(50),
    p95Ms: pct(95),
    opsPerSecond,
  };
  if (bytesPerOp !== undefined) {
    result.bytesPerOp = bytesPerOp;
    const bytesPerSecond = opsPerSecond * bytesPerOp;
    result.throughputMiBps = bytesPerSecond / (1024 * 1024);
  }
  return result;
}

/** Benchmark a synchronous function. */
export function benchmarkSync(fn: () => void, options: BenchmarkOptions = {}): BenchmarkResult {
  const iterations = options.iterations ?? 1000;
  const warmup = options.warmup ?? 50;
  if (iterations < 1) throw new BenchmarkError("iterations must be >= 1");
  for (let i = 0; i < warmup; i++) fn();
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples[i] = performance.now() - start;
  }
  return summarize(options.label ?? "benchmark", samples, options.bytesPerOp);
}

/** Benchmark a possibly-async function. */
export async function benchmark(
  fn: () => void | Promise<void>,
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const iterations = options.iterations ?? 1000;
  const warmup = options.warmup ?? 50;
  if (iterations < 1) throw new BenchmarkError("iterations must be >= 1");
  for (let i = 0; i < warmup; i++) await fn();
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples[i] = performance.now() - start;
  }
  return summarize(options.label ?? "benchmark", samples, options.bytesPerOp);
}

/** Sample current process memory usage. */
export function sampleMemory(): MemorySample {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
  };
}

// --- convenience benchmarks -------------------------------------------------

/** Benchmark AES-256-GCM encryption of a payload of `payloadSize` bytes. */
export function benchmarkEncryption(
  payloadSize = 1024,
  options: BenchmarkOptions = {},
): BenchmarkResult {
  const key = SymmetricKey.generate();
  const data = randomBytes(payloadSize);
  return benchmarkSync(() => void encrypt(key, data), {
    label: `encrypt-${payloadSize}B`,
    bytesPerOp: payloadSize,
    ...options,
  });
}

/** Benchmark AES-256-GCM decryption of a payload of `payloadSize` bytes. */
export function benchmarkDecryption(
  payloadSize = 1024,
  options: BenchmarkOptions = {},
): BenchmarkResult {
  const key = SymmetricKey.generate();
  const payload = encrypt(key, randomBytes(payloadSize));
  return benchmarkSync(() => void decrypt(key, payload), {
    label: `decrypt-${payloadSize}B`,
    bytesPerOp: payloadSize,
    ...options,
  });
}

/** Benchmark Ed25519 signing of a `payloadSize`-byte message. */
export function benchmarkSigning(
  payloadSize = 1024,
  options: BenchmarkOptions = {},
): BenchmarkResult {
  const kp = generateSigningKeyPair();
  const message = randomBytes(payloadSize);
  return benchmarkSync(() => void sign(kp.privateKey, message), {
    label: `sign-${payloadSize}B`,
    bytesPerOp: payloadSize,
    ...options,
  });
}

/** Benchmark Ed25519 verification of a `payloadSize`-byte message. */
export function benchmarkVerification(
  payloadSize = 1024,
  options: BenchmarkOptions = {},
): BenchmarkResult {
  const kp = generateSigningKeyPair();
  const message = randomBytes(payloadSize);
  const signature = sign(kp.privateKey, message);
  return benchmarkSync(() => void verify(kp.publicKey, message, signature), {
    label: `verify-${payloadSize}B`,
    bytesPerOp: payloadSize,
    ...options,
  });
}
