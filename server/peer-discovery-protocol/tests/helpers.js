/**
 * Test helpers for the Peer Discovery Protocol (Layer 6, Sprint 4). Node built-ins only.
 *
 * PDP is an ORCHESTRATION layer, so these helpers wire REAL in-memory Discovery + Presence +
 * Capability managers underneath a PeerDiscoveryManager — the tests are true integration tests of
 * the unified workflow. Everything is imported via SPECIFIC files (not index barrels) so mongoose
 * is never loaded; the whole stack runs DB-free under `node --test`. Not a test file.
 */

import { DiscoveryManager } from "../../peer-discovery/manager/discoveryManager.js";
import { createInMemoryDiscoveryRepository } from "../../peer-discovery/repository/inMemoryDiscoveryRepository.js";
import { createInMemoryDirectory } from "../../peer-discovery/registry/directory.js";
import { PresenceManager } from "../../presence/manager/presenceManager.js";
import { createInMemoryPresenceRepository } from "../../presence/repository/inMemoryPresenceRepository.js";
import { CapabilityManager } from "../../capabilities/manager/capabilityManager.js";
import { createInMemoryCapabilityRepository } from "../../capabilities/repository/inMemoryCapabilityRepository.js";

import { PeerDiscoveryManager } from "../manager/peerDiscoveryManager.js";
import { createInMemoryPdpRepository } from "../repositories/inMemoryPdpRepository.js";
import { ConnectionPlanCache } from "../cache/cache.js";
import { PdpEventBus } from "../events/events.js";

/** A controllable, deterministic clock. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** A monotonic id generator. */
export function makeIdGen(prefix = "pdp") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/**
 * Build a full PDP stack over real in-memory subsystems + a helper to seed a target user's devices
 * with discovery / presence / capabilities in one call.
 * @param {object} [options]
 */
export function makePdp(options = {}) {
  const clock = options.clock ?? makeClock();
  const idGenerator = options.idGenerator ?? makeIdGen();
  const directory = createInMemoryDirectory(options.directorySeed ?? {});
  const discovery = new DiscoveryManager({ ...createInMemoryDiscoveryRepository(), directory, clock });
  const presence = new PresenceManager({ ...createInMemoryPresenceRepository(), clock });
  const capabilities = new CapabilityManager({ ...createInMemoryCapabilityRepository(), clock });
  const events = new PdpEventBus();
  const cache = new ConnectionPlanCache({ clock, ...(options.cacheOptions ?? {}) });
  const manager = new PeerDiscoveryManager({
    discovery,
    presence,
    capabilities,
    ...createInMemoryPdpRepository(),
    cache,
    events,
    clock,
    idGenerator,
    selectionPolicy: options.selectionPolicy,
    maxDevices: options.maxDevices,
  });

  /** Register a requester device's capabilities (needed to negotiate). */
  async function registerRequester(userId, deviceId, caps = {}) {
    await capabilities.registerCapabilities({ userId, deviceId, transports: ["webrtc", "websocket", "relay"], compression: ["gzip"], featureFlags: { typing: true }, ...caps });
  }

  /**
   * Seed a target user with N devices: put them in the discovery directory + register presence +
   * register capabilities. Each device spec: `{ deviceId, transports?, present?, capable?, platform? }`.
   */
  async function seedUser(userId, devices) {
    directory.set(userId, {
      identity: { identityId: `id-${userId}`, publicKey: `PUB-${userId}`, fingerprint: `fp-${userId}` },
      devices: devices.map((d) => ({ deviceId: d.deviceId, identityId: `id-${userId}`, publicKey: `K-${d.deviceId}`, fingerprint: `f-${d.deviceId}`, platform: d.platform })),
    });
    for (const d of devices) {
      if (d.present !== false) await presence.registerPresence({ userId, deviceId: d.deviceId, platform: d.platform });
      if (d.capable !== false) await capabilities.registerCapabilities({ userId, deviceId: d.deviceId, transports: d.transports ?? ["webrtc", "relay"], compression: ["gzip"], featureFlags: { typing: true } });
    }
  }

  return { manager, discovery, presence, capabilities, directory, events, cache, clock, idGenerator, registerRequester, seedUser };
}

/** Collect every event a bus emits. */
export function recordEvents(events) {
  const log = [];
  events.on("*", (e) => log.push(e));
  log.types = () => log.map((e) => e.type);
  log.ofType = (type) => log.filter((e) => e.type === type);
  return log;
}
