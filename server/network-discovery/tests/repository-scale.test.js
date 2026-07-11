/**
 * Network Discovery repository contract, multiple interfaces, network changes, concurrency, and
 * large-scale/performance tests (Layer 7, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeClock, makeIdGen, mockStunTransport, latencyClock } from "./helpers.js";
import { createInMemoryDiscoveryRepository } from "../repository/inMemoryDiscoveryRepository.js";
import { createNetworkProfile } from "../profile/profile.js";
import { createStaticInterfaceProvider } from "../interfaces/interfaces.js";
import { StunClient } from "../stun/stunClient.js";
import { NetworkDiscoveryManager } from "../manager/networkDiscoveryManager.js";
import { createInMemoryDiscoveryRepository as mkRepo } from "../repository/inMemoryDiscoveryRepository.js";
import { NatType, ProfileState } from "../types/types.js";
import { ProfileNotFoundError } from "../errors.js";

const makeProfile = (deviceId, over = {}) =>
  createNetworkProfile({ deviceId, userId: over.userId ?? "u1", interfaces: over.interfaces ?? [{ name: "e", family: "IPv4", address: "10.0.0.1", internal: false }], candidates: over.candidates ?? [], nat: { natType: NatType.CONE, publicAddress: "1.2.3.4" }, clock: makeClock(), idGenerator: makeIdGen(deviceId), ...over });

// ---------------------------------------------------------------------------
describe("profile repository — contract", () => {
  let repo;
  beforeEach(() => {
    ({ profiles: repo } = createInMemoryDiscoveryRepository());
  });

  it("create / findById / findByDevice / update / delete + deep-copy", async () => {
    const p = makeProfile("d1");
    await repo.create(p);
    const got = await repo.findById(p.profileId);
    got.natType = "symmetric"; // mutate copy
    assert.equal((await repo.findById(p.profileId)).natType, NatType.CONE); // store untouched
    assert.equal((await repo.findByDevice("d1")).profileId, p.profileId);
    await repo.update(p.profileId, { version: 5 });
    assert.equal((await repo.findById(p.profileId)).version, 5);
    await assert.rejects(() => repo.update("missing-00000000", {}), ProfileNotFoundError);
    assert.equal(await repo.delete(p.profileId), true);
    assert.equal(await repo.findByDevice("d1"), null);
  });

  it("findByDevice returns the live profile; expired ones drop out", async () => {
    const p = makeProfile("d1");
    await repo.create(p);
    await repo.update(p.profileId, { state: ProfileState.EXPIRED });
    assert.equal(await repo.findByDevice("d1"), null);
  });

  it("listByUser + listExpired", async () => {
    const clock = makeClock();
    const a = createNetworkProfile({ deviceId: "d1", userId: "u1", interfaces: [{ name: "e", family: "IPv4", address: "10.0.0.1" }], candidates: [], nat: { natType: NatType.CONE }, ttlMs: 1000, clock, idGenerator: makeIdGen("a") });
    await repo.create(a);
    assert.equal((await repo.listByUser("u1")).length, 1);
    assert.equal((await repo.listExpired(new Date(clock() + 5000).toISOString())).length, 1);
    assert.equal((await repo.listExpired(new Date(clock()).toISOString())).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("history repository", () => {
  it("records + lists by device, newest first", async () => {
    const { history } = createInMemoryDiscoveryRepository();
    await history.record({ deviceId: "d1", action: "generate", at: "2026-01-01T00:00:00.000Z" });
    await history.record({ deviceId: "d1", action: "refresh", at: "2026-01-02T00:00:00.000Z" });
    await history.record({ deviceId: "d2", action: "generate", at: "2026-01-01T00:00:00.000Z" });
    const h = await history.listByDevice("d1");
    assert.equal(h.length, 2);
    assert.equal(h[0].action, "refresh");
    assert.equal((await history.listByDevice("d1", { limit: 1 })).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("multiple interfaces", () => {
  it("gathers a host candidate per usable interface (excludes internal/link-local)", async () => {
    const provider = createStaticInterfaceProvider({
      eth0: [{ family: "IPv4", address: "192.168.1.10", internal: false, port: 50000 }],
      wlan0: [{ family: "IPv4", address: "10.0.0.20", internal: false, port: 50001 }],
      eth1: [{ family: "IPv6", address: "fe80::1", internal: false }], // link-local excluded
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }], // internal excluded
    });
    const ctx = makeManager({ interfaceProvider: provider });
    const p = await ctx.manager.generateProfile({ deviceId: "multi", userId: "u1" });
    const hosts = p.candidates.filter((c) => c.type === "host").map((c) => c.ip).sort();
    assert.deepEqual(hosts, ["10.0.0.20", "192.168.1.10"]);
  });
});

// ---------------------------------------------------------------------------
describe("concurrency + scale", () => {
  it("concurrent discovery for distinct devices all persist", async () => {
    const ctx = makeManager();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => ctx.manager.generateProfile({ deviceId: `dev${i}`, userId: "u1" })));
    assert.equal(results.filter((p) => p.state === ProfileState.READY).length, 30);
    const ids = new Set(results.map((p) => p.profileId));
    assert.equal(ids.size, 30);
  });

  it("generates 500 device profiles under a generous budget", async () => {
    const clock = makeClock();
    const repo = mkRepo();
    const interfaceProvider = createStaticInterfaceProvider({ eth0: [{ family: "IPv4", address: "192.168.1.8", internal: false, port: 50000 }] });
    const stunClient = new StunClient({ transport: mockStunTransport(() => ({ ip: "203.0.113.9", port: 40000 })), servers: [{ host: "s", port: 1 }], retries: 0, clock: latencyClock() });
    const manager = new NetworkDiscoveryManager({ ...repo, interfaceProvider, stunClient, clock, idGenerator: makeIdGen() });
    const start = process.hrtime.bigint();
    await Promise.all(Array.from({ length: 500 }, (_, i) => manager.generateProfile({ deviceId: `d${i}`, userId: "u1" })));
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 4000, `500 discoveries took ${ms}ms`);
    assert.equal((await repo.profiles.listAll()).length, 500);
  });

  it("STUN codec: 1000 encode/parse round-trips stay fast", async () => {
    const { buildBindingRequest, encodeBindingResponse, parseStunMessage } = await import("../stun/stunMessage.js");
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      const { transactionId } = buildBindingRequest();
      const resp = encodeBindingResponse(transactionId, { ip: `203.0.113.${i % 256}`, port: 40000 + (i % 1000) });
      const parsed = parseStunMessage(resp);
      assert.ok(parsed.mappedAddress.port > 0);
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `1000 STUN round-trips took ${ms}ms`);
  });
});
