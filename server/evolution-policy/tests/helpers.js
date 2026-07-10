/**
 * Test helpers for the Automatic Rekeying engine. Node built-ins only (no MongoDB, no
 * external deps). Imports Sprint 2 forward-secrecy via SPECIFIC files (not the barrel) so
 * the Mongo model / mongoose is never loaded. Not a test file.
 */

import crypto from "node:crypto";
import { AutomaticRekeyManager } from "../manager/automaticRekeyManager.js";
import { createInMemoryPolicyRepository } from "../repository/inMemoryPolicyRepository.js";
import { RekeyEventBus } from "../events/events.js";
// Sprint 2 forward-secrecy (device mode) — specific files avoid mongoose.
import { ForwardSecrecyManager } from "../../forward-secrecy/manager/forwardSecrecyManager.js";
import { ForwardSecrecyKeyStore } from "../../forward-secrecy/keystore/forwardSecrecyKeyStore.js";
import { createInMemoryForwardSecrecyRepository } from "../../forward-secrecy/repository/inMemoryForwardSecrecyRepository.js";

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
  return crypto.createHash("sha256").update(`rekey-root-${seed}`).digest();
}

/**
 * Build a device-mode stack: a real forward-secrecy manager (with key store) wired to an
 * AutomaticRekeyManager, sharing one clock + event bus.
 * @param {{ cooldownMs?: number, maxAttempts?: number, retainedGenerations?: number }} [options]
 */
export function makeStack(options = {}) {
  const clock = makeClock();
  const events = new RekeyEventBus();
  const fs = new ForwardSecrecyManager({
    ...createInMemoryForwardSecrecyRepository(),
    keyStore: new ForwardSecrecyKeyStore(),
    clock,
    retainedGenerations: options.retainedGenerations,
  });
  const { rekeyPolicies, reset } = createInMemoryPolicyRepository();
  const manager = new AutomaticRekeyManager({
    rekeyPolicies,
    forwardSecrecy: fs,
    events,
    clock,
    cooldownMs: options.cooldownMs ?? 0, // default 0 in tests unless overridden
    maxAttempts: options.maxAttempts,
  });
  return { manager, fs, rekeyPolicies, events, clock, reset };
}

/** Start forward secrecy + return the sessionId (FS must exist before configuring rekey). */
export async function startFs(fs, over = {}) {
  const sessionId = over.sessionId ?? makeSessionId(over.seed ?? 1);
  await fs.start({
    sessionId,
    handshakeId: over.handshakeId ?? "hs-000001",
    participants: over.participants ?? ["alice", "bob"],
    rootSecret: over.rootSecret ?? makeSecret(over.seed ?? 1),
  });
  return sessionId;
}

/** Start FS + configure automatic rekeying with the given policies. */
export async function setup(stack, { policies = [], seed = 1, cooldownMs, sessionId } = {}) {
  const sid = sessionId ?? makeSessionId(seed);
  await startFs(stack.fs, { seed, sessionId: sid });
  await stack.manager.configure({ sessionId: sid, handshakeId: "hs-000001", policies, cooldownMs });
  return sid;
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
