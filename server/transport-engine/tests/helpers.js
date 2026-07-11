/**
 * Shared test helpers for the transport-engine (Layer 8, Sprint 2) suite. DB-free — everything runs
 * under `node --test` with in-memory repositories + a deterministic loopback network. Deterministic
 * clock + id generator + seeded payloads so fragmentation, scheduling, backoff, and expiry reproduce.
 */

import crypto from "node:crypto";
import { TransportEngine } from "../manager/transportEngine.js";
import { createInMemoryTransportRepository } from "../repository/inMemoryTransportRepository.js";
import { createLoopbackNetwork } from "../transport/wire.js";

/** A controllable clock. */
export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/** A deterministic, monotonic id generator. */
export function makeIdGen(prefix = "xfer") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(10, "0")}`;
}

/** Deterministic pseudo-random bytes (seeded) — stands in for opaque ciphertext. */
export function fakeCiphertext(bytes, seed = 1) {
  const buf = Buffer.alloc(bytes);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (Math.imul(x ^ (x >>> 15), x | 1) + 0x6d2b79f5) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

function bundle(repo) {
  return { transfers: repo.transfers, chunks: repo.chunks, progress: repo.progress, history: repo.history, audit: repo.audit };
}

/**
 * Build an N-device mesh wired by one deterministic loopback network. Returns the engines, per-device
 * received-payload collectors, event collectors, the network (with `flush` + `setDrop`), and clock.
 * @param {object} [options] `{ devices?, options? (engine options), clock?, drop? }`
 */
export function makeMesh(options = {}) {
  const deviceIds = options.devices ?? ["alice", "bob"];
  const clock = options.clock ?? makeClock();
  const idGen = options.idGen ?? makeIdGen();
  const net = createLoopbackNetwork({ drop: options.drop, onSend: options.onSend });

  const engines = {};
  const received = {};
  const events = {};
  for (const id of deviceIds) {
    const engine = new TransportEngine({
      deviceId: id,
      ...bundle(createInMemoryTransportRepository()),
      transport: net.transport,
      clock: clock.now,
      idGenerator: idGen,
      options: options.options,
    });
    net.routes.set(id, engine);
    engines[id] = engine;
    received[id] = [];
    events[id] = [];
    engine.onPayload((p) => received[id].push(p));
    engine.onEvent("*", (e) => events[id].push(e));
  }
  return { engines, received, events, net, clock, idGen };
}

/** Drive the network + optional retry sweeps until a transfer reaches a terminal state (or a cap). */
export async function runToCompletion(mesh, senderId, { maxRounds = 50, advanceMs = 10_000 } = {}) {
  await mesh.net.flush();
  for (let i = 0; i < maxRounds; i++) {
    mesh.clock.advance(advanceMs);
    const swept = await mesh.engines[senderId].sweepTimeouts();
    const delivered = await mesh.net.flush();
    if (delivered === 0 && swept.retried === 0) break;
  }
}

/** Count events of a type in a captured stream. */
export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

export { crypto };
