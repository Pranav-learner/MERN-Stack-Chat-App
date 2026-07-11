/**
 * Shared test helpers for the data-plane (Layer 8, Sprint 1) suite. DB-free — everything runs under
 * `node --test` with in-memory repositories + a loopback transport. Deterministic clock + id
 * generator so ordering, backoff, and expiry are reproducible.
 */

import { MessagingEngine } from "../manager/messagingEngine.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import { createLoopbackTransport } from "../transport/wire.js";

/** A controllable clock. `advance(ms)` moves time forward; `now()` reads it. */
export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/** A deterministic, monotonic id generator (valid message-id shape: 8–128 of [A-Za-z0-9_-]). */
export function makeIdGen(prefix = "msg") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(12, "0")}`;
}

/** A fake ciphertext envelope (opaque — never inspected by the engine). */
export function cipher(tag = "ct") {
  return { alg: "AES-256-GCM", iv: "0011223344556677", ciphertext: Buffer.from(String(tag)).toString("base64"), tag: "deadbeef" };
}

function pick(repo) {
  return { messages: repo.messages, inbound: repo.inbound, ackHistory: repo.ackHistory, ordering: repo.ordering };
}

/**
 * Build a two-device mesh (`a` ↔ `b`) wired by a loopback transport with a controllable link switch.
 * Returns the engines, delivered-message collectors, the link switch, clock, and a helper to build
 * raw DATA envelopes for a synthetic third sender.
 *
 * @param {object} [options] @param {string[]} [options.devices] @param {object} [options.retryPolicy]
 */
export function makeMesh(options = {}) {
  const deviceIds = options.devices ?? ["a", "b"];
  const clock = options.clock ?? makeClock();
  const idGen = options.idGen ?? makeIdGen();
  const registry = new Map();
  const link = { up: true };
  const sends = [];
  const transport = createLoopbackTransport({
    route: (id) => registry.get(id),
    up: () => link.up,
    onSend: (env) => sends.push(env),
  });

  const engines = {};
  const delivered = {};
  const events = {};
  for (const id of deviceIds) {
    const engine = new MessagingEngine({
      deviceId: id,
      ...pick(createInMemoryMessageRepository()),
      transport,
      retryPolicy: options.retryPolicy,
      clock: clock.now,
      idGenerator: idGen,
    });
    registry.set(id, engine);
    engines[id] = engine;
    delivered[id] = [];
    events[id] = [];
    engine.onMessage((d) => delivered[id].push(d));
    engine.onEvent("*", (e) => events[id].push(e));
  }

  return { engines, delivered, events, link, clock, idGen, sends, registry, transport };
}

/** Build a raw DATA wire envelope (for direct `engine.receive` ordering/dedup tests). */
export function dataEnvelope({ messageId, conversationId = "conv", sender = "z", receiver = "b", seq, payload = cipher(seq), ts = "2024-01-01T00:00:00.000Z" }) {
  return { type: "data", protocol: "1.0", messageId, conversationId, sender, receiver, connectionId: null, seq, payload, retry: 0, ts };
}

/** Count events of a type across a device's captured stream. */
export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}
