/**
 * Test helpers for the Endpoint Selection subsystem (Layer 6, Sprint 5). Node built-ins only.
 *
 * Imports the framework via SPECIFIC files (not the `index.js` barrel) so the Mongo models /
 * mongoose are never loaded — the whole stack runs DB-free under `node --test`. Not a test file.
 */

import { EndpointSelectionManager } from "../manager/endpointSelectionManager.js";
import { createInMemoryEndpointRepository } from "../repository/inMemoryEndpointRepository.js";
import { EndpointCache } from "../cache/cache.js";
import { EndpointEventBus } from "../events/events.js";

/** A controllable, deterministic clock. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** A monotonic id generator. */
export function makeIdGen(prefix = "es") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** Build a negotiation-result capability object (matches the capability subsystem's result DTO). */
export function cap(over = {}) {
  return {
    compatible: true,
    protocolVersion: "1.0",
    cryptoVersion: "1.0",
    sharedTransports: ["webrtc", "relay"],
    preferredTransport: "webrtc",
    fallbackChain: ["relay"],
    compression: "gzip",
    featureFlags: { typing: true },
    relay: true,
    ...over,
  };
}

/** Build a candidate endpoint. */
export function candidate(deviceId, over = {}) {
  return {
    deviceId,
    identityId: `id-${deviceId}`,
    presenceStatus: "online",
    platform: "web",
    lastSeen: new Date(1_700_000_000_000).toISOString(),
    capabilities: cap(),
    ...over,
  };
}

/** Build a fully-wired in-memory EndpointSelectionManager. */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const idGenerator = options.idGenerator ?? makeIdGen();
  const repo = createInMemoryEndpointRepository();
  const events = new EndpointEventBus();
  const cache = new EndpointCache({ clock, ...(options.cacheOptions ?? {}) });
  const manager = new EndpointSelectionManager({
    plans: repo.plans,
    reliability: repo.reliability,
    selections: options.withHistory === false ? undefined : repo.selections,
    cache,
    events,
    clock,
    idGenerator,
    defaultPolicy: options.defaultPolicy,
    maxFallbacks: options.maxFallbacks,
    securityRequirements: options.securityRequirements,
  });
  return { manager, repo, events, cache, clock, idGenerator };
}

/** Collect every event a bus emits. */
export function recordEvents(events) {
  const log = [];
  events.on("*", (e) => log.push(e));
  log.types = () => log.map((e) => e.type);
  log.ofType = (type) => log.filter((e) => e.type === type);
  return log;
}
