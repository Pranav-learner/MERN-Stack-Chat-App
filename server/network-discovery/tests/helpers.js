/**
 * Test helpers for the Network Discovery subsystem (Layer 7, Sprint 1). Node built-ins only.
 * Imports via SPECIFIC files (not index) so mongoose is never loaded — DB-free under `node --test`.
 * Not a test file.
 */

import { NetworkDiscoveryManager } from "../manager/networkDiscoveryManager.js";
import { createInMemoryDiscoveryRepository } from "../repository/inMemoryDiscoveryRepository.js";
import { StunClient } from "../stun/stunClient.js";
import { encodeBindingResponse } from "../stun/stunMessage.js";
import { createStaticInterfaceProvider } from "../interfaces/interfaces.js";
import { NetworkProfileCache } from "../cache/cache.js";
import { DiscoveryEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

export function makeIdGen(prefix = "prof") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** A monotonic latency clock for STUN (deterministic). */
export function latencyClock(step = 3) {
  let t = 0;
  return () => (t += step);
}

/**
 * A mock STUN transport that maps every request to a public address. `mapper(server, i)` returns
 * `{ ip, port } | null` (null → this server "fails"). Default: a consistent (cone) mapping.
 */
export function mockStunTransport(mapper) {
  const map = mapper ?? (() => ({ ip: "203.0.113.9", port: 40000 }));
  let i = 0;
  return {
    async query(message, server) {
      const mapped = map(server, i++);
      if (!mapped) throw new Error("stun-timeout");
      const txid = message.subarray(8, 20);
      return encodeBindingResponse(txid, mapped);
    },
  };
}

/** Common static interfaces: one private LAN address + loopback. */
export function staticInterfaces(over = {}) {
  return createStaticInterfaceProvider({
    wlo1: [{ family: "IPv4", address: over.address ?? "192.168.1.8", internal: false, mac: "aa:bb:cc", port: over.port ?? 50000 }],
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  });
}

/**
 * Build a fully-wired in-memory NetworkDiscoveryManager. `stun` controls the mock STUN mapper.
 */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const idGenerator = options.idGenerator ?? makeIdGen();
  const repo = createInMemoryDiscoveryRepository();
  const events = new DiscoveryEventBus();
  const cache = new NetworkProfileCache({ clock, ...(options.cacheOptions ?? {}) });
  const stunClient = options.noStun
    ? null
    : new StunClient({ transport: mockStunTransport(options.stunMapper), servers: options.servers ?? [{ host: "s1", port: 1 }, { host: "s2", port: 2 }], retries: options.retries ?? 0, clock: latencyClock() });
  const interfaceProvider = options.interfaceProvider ?? staticInterfaces(options.interfaces);
  const manager = new NetworkDiscoveryManager({
    profiles: repo.profiles,
    history: options.noHistory ? undefined : repo.history,
    interfaceProvider,
    stunClient,
    cache,
    events,
    clock,
    idGenerator,
    profileTtlMs: options.profileTtlMs,
  });
  return { manager, repo, events, cache, clock, idGenerator, stunClient, interfaceProvider };
}

/** Collect every event a bus emits. */
export function recordEvents(events) {
  const log = [];
  events.on("*", (e) => log.push(e));
  log.types = () => log.map((e) => e.type);
  log.ofType = (type) => log.filter((e) => e.type === type);
  return log;
}
