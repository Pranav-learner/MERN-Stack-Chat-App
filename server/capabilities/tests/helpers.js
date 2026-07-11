/**
 * Test helpers for the Capability Exchange subsystem (Layer 6, Sprint 3). Node built-ins only.
 *
 * Imports the framework via SPECIFIC files (not the `index.js` barrel) so the Mongo models /
 * mongoose are never loaded — the whole stack runs DB-free under `node --test`. Not a test file.
 */

import { CapabilityManager } from "../manager/capabilityManager.js";
import { createInMemoryCapabilityRepository } from "../repository/inMemoryCapabilityRepository.js";
import { CapabilityCache } from "../cache/cache.js";
import { CapabilityEventBus } from "../events/events.js";

/** A controllable, deterministic clock. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** A monotonic id generator. */
export function makeIdGen(prefix = "cap") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/**
 * Build a fully-wired in-memory CapabilityManager with a controllable clock + id generator, a
 * fresh event bus + cache, and (optionally) the negotiation-history repo enabled.
 * @param {object} [options]
 */
export function makeCapabilities(options = {}) {
  const clock = options.clock ?? makeClock();
  const idGenerator = options.idGenerator ?? makeIdGen();
  const repo = createInMemoryCapabilityRepository();
  const events = new CapabilityEventBus();
  const cache = new CapabilityCache({ clock, ...(options.cacheOptions ?? {}) });
  const manager = new CapabilityManager({
    capabilities: repo.capabilities,
    negotiations: options.withHistory === false ? undefined : repo.negotiations,
    events,
    cache,
    clock,
    idGenerator,
    ttlMs: options.ttlMs,
    defaultPolicy: options.defaultPolicy,
  });
  return { manager, repo, events, cache, clock, idGenerator };
}

/** A reasonable default capability registration payload. */
export function caps(userId, deviceId, over = {}) {
  return {
    userId,
    deviceId,
    protocolVersions: ["1.0"],
    cryptoVersions: ["1.0"],
    transports: ["websocket", "relay"],
    compression: ["gzip", "none"],
    featureFlags: { typing: true, receipts: true },
    maxPayloadSize: 16 * 1024 * 1024,
    ...over,
  };
}

/** Collect every event a bus emits. */
export function recordEvents(events) {
  const log = [];
  events.on("*", (e) => log.push(e));
  log.types = () => log.map((e) => e.type);
  log.ofType = (type) => log.filter((e) => e.type === type);
  return log;
}
