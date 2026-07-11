/**
 * Test helpers for the Presence Service (Layer 6, Sprint 2). Node built-ins only.
 *
 * Imports the framework via SPECIFIC files (not the `index.js` barrel) so the Mongo models /
 * mongoose are never loaded — the whole presence stack runs DB-free under `node --test`. Not a
 * test file.
 */

import { PresenceManager } from "../manager/presenceManager.js";
import { createInMemoryPresenceRepository } from "../repository/inMemoryPresenceRepository.js";
import { PresenceCache } from "../cache/cache.js";
import { PresenceEventBus } from "../events/events.js";
import { HeartbeatMonitor } from "../heartbeat/heartbeat.js";
import { createPresenceService } from "../services/presenceService.js";

/** A controllable, deterministic clock (so heartbeat/TTL tests never wall-clock-sleep). */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** A monotonic id generator (stable ids → predictable assertions). */
export function makeIdGen(prefix = "pres") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** A PUBLIC identity record (advertisement input). */
export function makeIdentity(userId, seed = 1) {
  return { identityId: `id-${userId}`, publicKey: `IDPUB-${userId}-${seed}`, algorithm: "ed25519", fingerprint: `id:${userId}:${seed}`, version: 1 };
}

/**
 * Build a fully-wired in-memory PresenceManager with a controllable clock + id generator, a
 * fresh event bus + cache, and a heartbeat monitor + service. Returns every piece so tests can
 * poke each collaborator directly.
 * @param {object} [options]
 * @param {() => number} [options.clock] @param {number} [options.heartbeatTimeoutMs]
 * @param {object} [options.cacheOptions]
 */
export function makePresence(options = {}) {
  const clock = options.clock ?? makeClock();
  const idGenerator = options.idGenerator ?? makeIdGen();
  const repo = createInMemoryPresenceRepository();
  const events = new PresenceEventBus();
  const cache = new PresenceCache({ clock, ...(options.cacheOptions ?? {}) });
  const manager = new PresenceManager({
    ...repo,
    events,
    cache,
    clock,
    idGenerator,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 45_000,
  });
  const monitor = new HeartbeatMonitor({ manager, intervalMs: options.intervalMs ?? 10_000 });
  const service = createPresenceService({ manager });
  return { manager, repo, events, cache, clock, idGenerator, monitor, service };
}

/** Collect every event a bus emits into an array (for assertions). */
export function recordEvents(events) {
  const log = [];
  events.on("*", (e) => log.push(e));
  log.types = () => log.map((e) => e.type);
  log.ofType = (type) => log.filter((e) => e.type === type);
  return log;
}
