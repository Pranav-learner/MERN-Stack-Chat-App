/**
 * Test helpers for the Session Evolution Framework. Node built-ins only (no MongoDB, no
 * external deps). Not a test file.
 */

import { EvolutionManager } from "../manager/evolutionManager.js";
import { createInMemoryEvolutionRepository } from "../repository/inMemoryEvolutionRepository.js";
import { EvolutionScheduler } from "../schedulers/scheduler.js";
import { EvolutionEventBus } from "../events/events.js";

/** A controllable clock: `clock()` reads current ms; `advance(ms)` moves it forward. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** Deterministic id generator (`evo-000001`, …) — satisfies the 8+ char id rule. */
export function makeIdGen(prefix = "evo") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, "0")}`;
}

/** A deterministic 12+ char session id (matches the session-id shape). */
export function makeSessionId(seed = 1) {
  return `session-${String(seed).padStart(6, "0")}`;
}

/**
 * Build an EvolutionManager with in-memory repo, a controllable clock, deterministic
 * ids, a scheduler, and an event bus.
 * @param {{ defaultPolicies?: object[] }} [options]
 */
export function makeManager(options = {}) {
  const clock = makeClock();
  const events = new EvolutionEventBus();
  const { evolutions, reset } = createInMemoryEvolutionRepository();
  const scheduler = new EvolutionScheduler({ clock });
  const manager = new EvolutionManager({
    evolutions,
    events,
    scheduler,
    clock,
    idGenerator: makeIdGen(),
    defaultPolicies: options.defaultPolicies,
  });
  return { manager, evolutions, scheduler, events, clock, reset };
}

/** Create an evolution record with sane defaults. */
export async function create(manager, over = {}) {
  return manager.createEvolutionState({
    sessionId: over.sessionId ?? makeSessionId(over.seed ?? 1),
    handshakeId: over.handshakeId ?? "hs-000001",
    ...over,
  });
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
