/**
 * @module shs/hardening/perf/benchmark
 *
 * A lightweight, dependency-free micro-benchmark harness for the Secure Handshake
 * System hot paths (handshake lifecycle, key agreement, session creation, session
 * lookup, serialization, validation). It measures wall-clock throughput + latency
 * percentiles so regressions are visible; it is NOT a correctness test.
 *
 * Run ad-hoc: `node shs/hardening/perf/benchmark.js` (see the CLI block below), or call
 * {@link runBenchmark} programmatically (a small run is exercised by the test suite).
 *
 * @security No secrets are logged — only counts + timings.
 */

import { performance } from "node:perf_hooks";

/**
 * Time `iterations` runs of `fn`, returning throughput + latency percentiles (ms).
 * @param {string} name @param {(i: number) => any | Promise<any>} fn
 * @param {{ iterations?: number, warmup?: number }} [options]
 * @returns {Promise<{ name: string, iterations: number, totalMs: number, opsPerSec: number, p50: number, p95: number, p99: number, mean: number }>}
 */
export async function bench(name, fn, options = {}) {
  const iterations = options.iterations ?? 1000;
  const warmup = options.warmup ?? Math.min(50, Math.floor(iterations / 10));
  for (let i = 0; i < warmup; i++) await fn(i);

  const samples = new Array(iterations);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn(i);
    samples[i] = performance.now() - t0;
  }
  const totalMs = performance.now() - start;
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    name,
    iterations,
    totalMs: round(totalMs),
    opsPerSec: Math.round((iterations / totalMs) * 1000),
    mean: round(mean),
    p50: round(q(50)),
    p95: round(q(95)),
    p99: round(q(99)),
  };
}

/**
 * Run the standard SHS benchmark suite against the real Sprint 1–3 managers.
 * @param {{ iterations?: number }} [options]
 * @returns {Promise<object[]>} one result row per scenario
 */
export async function runBenchmark(options = {}) {
  const iterations = options.iterations ?? 500;
  const { HandshakeManager } = await import("../../manager/handshakeManager.js");
  const { createInMemoryShsRepository } = await import("../../repository/inMemoryRepository.js");
  const { serialize, deserialize, SerializationFormat } = await import("../../serializers/serializer.js");
  const { buildRequest } = await import("../../messages/messages.js");
  const { validateMessage } = await import("../../validators/validators.js");
  const { SecureSessionManager } = await import("../../session/manager/sessionManager.js");
  const { createInMemorySessionRepository } = await import("../../session/repository/inMemoryRepository.js");
  const { SecureKeyStore } = await import("../../session/storage/secureKeyStore.js");
  const crypto = await import("node:crypto");

  const results = [];

  // Handshake full lifecycle (start → accept → complete).
  const hm = new HandshakeManager({ ...createInMemoryShsRepository() });
  let n = 0;
  results.push(
    await bench("handshake.lifecycle", async () => {
      const { session } = await hm.startHandshake({ initiator: `u${n}`, responder: `v${n}`, initiatorDevice: "d" });
      n++;
      await hm.acceptHandshake(session.handshakeId, session.responder ?? `v${n - 1}`, {});
      await hm.completeHandshake(session.handshakeId, session.initiator);
    }, { iterations }),
  );

  // Session creation + lookup.
  const sm = new SecureSessionManager({ ...createInMemorySessionRepository(), keyStore: new SecureKeyStore() });
  const secret = crypto.randomBytes(32);
  let sid = null;
  let screate = 0; // monotonic across warmup + timed loop so handshake ids never collide
  results.push(
    await bench("session.create", async () => {
      const s = await sm.establishSession({ handshakeId: `hs${screate++}`, participants: ["a", "b"], sharedSecret: secret });
      sid = s.sessionId;
    }, { iterations }),
  );
  results.push(await bench("session.lookup", async () => sm.getSession(sid), { iterations }));

  // Serialization round-trip + validation.
  const msg = buildRequest({ handshakeId: "h", initiator: "a", responder: "b", initiatorDevice: "d", version: "1.0" });
  results.push(await bench("serialize.binary", async () => deserialize(serialize(msg, SerializationFormat.BINARY), SerializationFormat.BINARY), { iterations }));
  results.push(await bench("validate.message", async () => validateMessage(msg), { iterations }));

  return results;
}

const round = (n) => Math.round(n * 1000) / 1000;

// CLI: `node shs/hardening/perf/benchmark.js [iterations]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const iterations = Number(process.argv[2]) || 2000;
  runBenchmark({ iterations }).then((rows) => {
    console.table(rows);
  });
}
