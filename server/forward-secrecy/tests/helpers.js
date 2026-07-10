/**
 * Test helpers for the Forward Secrecy Engine. Node built-ins only (no MongoDB, no
 * external deps). Not a test file.
 */

import crypto from "node:crypto";
import { ForwardSecrecyManager } from "../manager/forwardSecrecyManager.js";
import { ForwardSecrecyKeyStore } from "../keystore/forwardSecrecyKeyStore.js";
import { createInMemoryForwardSecrecyRepository } from "../repository/inMemoryForwardSecrecyRepository.js";
import { ForwardSecrecyEventBus } from "../events/events.js";

/** A controllable clock. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** A deterministic 12+ char session id. */
export function makeSessionId(seed = 1) {
  return `session-${String(seed).padStart(6, "0")}`;
}

/** A fixed 32-byte root secret (deterministic per seed). */
export function makeSecret(seed = 1) {
  return crypto.createHash("sha256").update(`fs-root-${seed}`).digest();
}

/**
 * Build a device-mode ForwardSecrecyManager with in-memory repo, key store, a
 * controllable clock, and an event bus.
 * @param {{ retainedGenerations?: number, evolution?: object }} [options]
 */
export function makeManager(options = {}) {
  const clock = makeClock();
  const events = new ForwardSecrecyEventBus();
  const { forwardSecrecy, reset } = createInMemoryForwardSecrecyRepository();
  const keyStore = options.descriptorMode ? undefined : new ForwardSecrecyKeyStore();
  const manager = new ForwardSecrecyManager({
    forwardSecrecy,
    keyStore,
    events,
    clock,
    retainedGenerations: options.retainedGenerations,
    evolution: options.evolution,
  });
  return { manager, forwardSecrecy, keyStore, events, clock, reset };
}

/** Start FS for a session with sane defaults. */
export async function start(manager, over = {}) {
  return manager.start({
    sessionId: over.sessionId ?? makeSessionId(over.seed ?? 1),
    handshakeId: over.handshakeId ?? "hs-000001",
    participants: over.participants ?? ["alice", "bob"],
    deviceIds: over.deviceIds ?? { initiator: "devA", responder: "devB" },
    rootSecret: over.rootSecret ?? makeSecret(over.seed ?? 1),
    ...over,
  });
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
