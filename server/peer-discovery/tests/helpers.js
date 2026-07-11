/**
 * Test helpers for the Peer Discovery Framework (Layer 6, Sprint 1). Node built-ins only.
 *
 * Imports the framework via SPECIFIC files (not the `index.js` barrel) so the Mongo models
 * / mongoose are never loaded — the whole discovery stack runs DB-free under `node --test`.
 * Not a test file.
 */

import { DiscoveryManager } from "../manager/discoveryManager.js";
import { createInMemoryDiscoveryRepository } from "../repository/inMemoryDiscoveryRepository.js";
import { createInMemoryDirectory } from "../registry/directory.js";
import { DiscoveryCache } from "../cache/cache.js";
import { DiscoveryEventBus } from "../events/events.js";

/** A controllable, deterministic clock (so TTL/expiry tests never wall-clock-sleep). */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** A monotonic id generator (stable ids across a test → predictable dedupe keys). */
export function makeIdGen(prefix = "disc") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** Build a PUBLIC identity record (directory shape). */
export function makeIdentity(userId, seed = 1) {
  return {
    identityId: `id-${userId}`,
    publicKey: `IDPUB-${userId}-${seed}`,
    algorithm: "ed25519",
    fingerprint: `id:${userId}:${seed}`,
    version: 1,
  };
}

/** Build a PUBLIC device record (directory shape). */
export function makeDevice(userId, deviceId, overrides = {}) {
  return {
    deviceId,
    identityId: `id-${userId}`,
    publicKey: `DPUB-${userId}-${deviceId}`,
    algorithm: "ed25519",
    fingerprint: `dev:${userId}:${deviceId}`,
    name: `${deviceId}@${userId}`,
    platform: "web",
    ...overrides,
  };
}

/** Seed a directory for a user with N devices (+ identity). */
export function seedUser(userId, deviceCount = 2, overrides = {}) {
  const devices = Array.from({ length: deviceCount }, (_, i) => makeDevice(userId, `d${i + 1}`));
  return { [userId]: { identity: makeIdentity(userId), devices, ...overrides } };
}

/**
 * Build a fully-wired in-memory DiscoveryManager with a controllable clock + id generator,
 * an in-memory directory, and a fresh event bus + cache. Returns every piece so tests can
 * poke each collaborator directly.
 *
 * @param {object} [options]
 * @param {Record<string, {identity?: object, devices?: object[]}>} [options.seed] directory seed
 * @param {() => number} [options.clock]
 * @param {number} [options.dedupeWindowMs]
 * @param {object} [options.cacheOptions] forwarded to DiscoveryCache
 */
export function makeDiscovery(options = {}) {
  const clock = options.clock ?? makeClock();
  const idGenerator = options.idGenerator ?? makeIdGen();
  const repo = createInMemoryDiscoveryRepository();
  const directory = createInMemoryDirectory(options.seed ?? {});
  const events = new DiscoveryEventBus();
  const cache = new DiscoveryCache({ clock, ...(options.cacheOptions ?? {}) });
  const manager = new DiscoveryManager({
    ...repo,
    directory,
    events,
    cache,
    clock,
    idGenerator,
    dedupeWindowMs: options.dedupeWindowMs,
  });
  return { manager, repo, directory, events, cache, clock, idGenerator };
}

/** Collect every event a bus emits into an array (for assertions). */
export function recordEvents(events) {
  const log = [];
  events.on("*", (e) => log.push(e));
  log.types = () => log.map((e) => e.type);
  log.ofType = (type) => log.filter((e) => e.type === type);
  return log;
}
