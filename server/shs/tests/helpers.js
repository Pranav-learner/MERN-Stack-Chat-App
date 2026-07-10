/**
 * Test helpers for the Secure Handshake System. Node built-ins only — no MongoDB,
 * no external deps (runs under `node --test`). Not a test file.
 */

import { HandshakeManager } from "../manager/handshakeManager.js";
import { createInMemoryShsRepository } from "../repository/inMemoryRepository.js";
import { HandshakeEventBus } from "../events/events.js";
import { RetryPolicy } from "../retry/retry.js";

/** A controllable clock: `clock()` reads current ms; `advance(ms)` moves it forward. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
    return now;
  };
  clock.set = (ms) => {
    now = ms;
    return now;
  };
  return clock;
}

/** A deterministic id generator (`hs-1`, `hs-2`, …) with a configurable prefix. */
export function makeIdGen(prefix = "hs") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** An in-memory identity/device directory the manager can look up. */
export function makeDirectory() {
  const identities = new Map();
  const devices = new Map(); // key: `${userId}:${deviceId}` -> device
  return {
    addUser(userId, { deviceId } = {}) {
      identities.set(String(userId), { userId: String(userId), identityId: `id-${userId}`, publicKey: "pk", algorithm: "ed25519" });
      if (deviceId) devices.set(`${userId}:${deviceId}`, { deviceId, userId: String(userId), fingerprint: `fp-${deviceId}` });
      return this;
    },
    removeUser(userId) {
      identities.delete(String(userId));
    },
    identityLookup: async (userId) => identities.get(String(userId)) ?? null,
    deviceLookup: async (userId, deviceId) => devices.get(`${userId}:${deviceId}`) ?? null,
  };
}

/**
 * Build a HandshakeManager wired with in-memory repo, a controllable clock, a
 * deterministic id generator, and an event bus. Returns everything for assertions.
 *
 * @param {object} [options]
 * @param {boolean} [options.withDirectory=false] wire identity/device lookups
 * @param {number} [options.ttlMs] override the whole-handshake TTL
 * @param {RetryPolicy} [options.retryPolicy]
 * @param {string[]} [options.requiredCapabilities]
 */
export function makeManager(options = {}) {
  const clock = makeClock();
  const idGen = makeIdGen();
  const events = new HandshakeEventBus();
  const { sessions, reset } = createInMemoryShsRepository();

  let directory = null;
  if (options.withDirectory) {
    directory = makeDirectory();
    directory.addUser("alice", { deviceId: "dev-a" });
    directory.addUser("bob", { deviceId: "dev-b" });
    directory.addUser("carol", { deviceId: "dev-c" });
  }

  const manager = new HandshakeManager({
    sessions,
    events,
    clock,
    idGenerator: idGen,
    ttlMs: options.ttlMs,
    retryPolicy: options.retryPolicy,
    requiredCapabilities: options.requiredCapabilities,
    identityLookup: directory?.identityLookup,
    deviceLookup: directory?.deviceLookup,
  });

  return { manager, sessions, events, clock, idGen, directory, reset };
}

/** Collect all events into an array for assertions. Returns the array + unsubscribe. */
export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}

/** Start a WAITING handshake between two users (defaults alice→bob). */
export async function startAB(manager, initiator = "alice", responder = "bob", initiatorDevice = "dev-a") {
  return manager.startHandshake({ initiator, responder, initiatorDevice });
}
