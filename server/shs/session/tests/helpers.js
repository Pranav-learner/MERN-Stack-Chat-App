/**
 * Test helpers for the Secure Session subsystem. Node built-ins only (no MongoDB, no
 * external deps). Not a test file.
 */

import crypto from "node:crypto";
import { SecureSessionManager } from "../manager/sessionManager.js";
import { createInMemorySessionRepository } from "../repository/inMemoryRepository.js";
import { SecureKeyStore } from "../storage/secureKeyStore.js";
import { SessionEventBus } from "../events/events.js";

/** A controllable clock: `clock()` reads current ms; `advance(ms)` moves it forward. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** Deterministic id generator (`session-000001`, …) — satisfies the 8+ char id rule. */
export function makeIdGen(prefix = "session") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, "0")}`;
}

/** A fixed 32-byte shared secret (deterministic per seed for reproducibility). */
export function makeSecret(seed = 1) {
  return crypto.createHash("sha256").update(`secret-${seed}`).digest();
}

/**
 * Build a device-mode SecureSessionManager with in-memory repo, key store, a
 * controllable clock, deterministic ids, and an event bus.
 * @param {{ maxLifetimeMs?: number, idleTimeoutMs?: number, descriptorMode?: boolean }} [options]
 */
export function makeManager(options = {}) {
  const clock = makeClock();
  const events = new SessionEventBus();
  const { sessions, reset } = createInMemorySessionRepository();
  const keyStore = options.descriptorMode ? undefined : new SecureKeyStore();
  const manager = new SecureSessionManager({
    sessions,
    keyStore,
    events,
    clock,
    idGenerator: makeIdGen(),
    maxLifetimeMs: options.maxLifetimeMs,
    idleTimeoutMs: options.idleTimeoutMs,
  });
  return { manager, sessions, keyStore, events, clock, reset };
}

/** Establish a session (device mode) with sane defaults. */
export async function establish(manager, over = {}) {
  return manager.establishSession({
    handshakeId: over.handshakeId ?? "hs-1",
    participants: over.participants ?? ["alice", "bob"],
    deviceIds: over.deviceIds ?? { initiator: "devA", responder: "devB" },
    sharedSecret: over.sharedSecret ?? makeSecret(over.seed ?? 1),
    ...over,
  });
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
