/**
 * Test helpers for the Key Hierarchy subsystem. Node built-ins only (no MongoDB, no external
 * deps). Not a test file.
 */

import crypto from "node:crypto";
import { ChainManager } from "../manager/chainManager.js";
import { KeyHierarchyKeyStore } from "../keystore/keyHierarchyKeyStore.js";
import { createInMemoryKeyHierarchyRepository } from "../repository/inMemoryKeyHierarchyRepository.js";
import { KeyHierarchyEventBus } from "../events/events.js";

/** A controllable clock. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  return clock;
}

/** A deterministic 12+ char session id. */
export function makeSessionId(seed = 1) {
  return `session-${String(seed).padStart(6, "0")}`;
}

/** A fixed 32-byte root secret (deterministic per seed) — stands in for FS ratchetMaterial. */
export function makeSecret(seed = 1) {
  return crypto.createHash("sha256").update(`kh-root-${seed}`).digest();
}

/**
 * Build a device-mode ChainManager (with key store), a controllable clock, and an event bus.
 * @param {{ descriptorMode?: boolean }} [options]
 */
export function makeManager(options = {}) {
  const clock = makeClock();
  const events = new KeyHierarchyEventBus();
  const { hierarchies, reset } = createInMemoryKeyHierarchyRepository();
  const keyStore = options.descriptorMode ? undefined : new KeyHierarchyKeyStore();
  const manager = new ChainManager({ hierarchies, keyStore, events, clock });
  return { manager, hierarchies, keyStore, events, clock, reset };
}

/** Establish the hierarchy with sane defaults. */
export async function establish(manager, over = {}) {
  return manager.establish({
    sessionId: over.sessionId ?? makeSessionId(over.seed ?? 1),
    handshakeId: over.handshakeId ?? "hs-000001",
    role: over.role ?? "initiator",
    rootSecret: over.rootSecret ?? makeSecret(over.seed ?? 1),
    generation: over.generation,
    participants: over.participants ?? ["alice", "bob"],
  });
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
