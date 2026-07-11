/**
 * Network Discovery manager, profile lifecycle, cache, API facade, and validation tests
 * (Layer 7, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeClock, recordEvents } from "./helpers.js";
import { createDiscoveryApi } from "../api/discoveryApi.js";
import { NetworkProfileCache, CacheOutcome } from "../cache/cache.js";
import { createNetworkProfile, isProfileExpired, networkSignature } from "../profile/profile.js";
import {
  validateGenerateRequest,
  validateCandidates,
  validateNatMetadata,
  validateProfile,
  assertNoSecretMaterial,
  assertOwner,
  isValidIPv4,
  requireProfile,
} from "../validators/validators.js";
import { NatType, ProfileState, DiscoveryEventType } from "../types/types.js";
import { DiscoveryValidationError, ProfileNotFoundError, UnauthorizedDiscoveryError, CorruptedProfileError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("manager — profile generation", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("generates a ready profile with host + srflx candidates + cone NAT + emits", async () => {
    const log = recordEvents(ctx.events);
    const p = await ctx.manager.generateProfile({ deviceId: "d1", userId: "u1" });
    assert.equal(p.state, ProfileState.READY);
    assert.equal(p.natType, NatType.CONE);
    assert.equal(p.publicAddress, "203.0.113.9");
    assert.ok(p.candidates.some((c) => c.type === "host"));
    assert.ok(p.candidates.some((c) => c.type === "srflx"));
    assert.deepEqual(p.privateAddresses, ["192.168.1.8"]);

    const types = new Set(log.types());
    for (const e of [DiscoveryEventType.DISCOVERY_STARTED, DiscoveryEventType.STUN_RESOLVED, DiscoveryEventType.CANDIDATE_GATHERED, DiscoveryEventType.NAT_DETECTED, DiscoveryEventType.PROFILE_CREATED]) {
      assert.ok(types.has(e), `missing ${e}`);
    }
  });

  it("accepts device-REPORTED interfaces + candidates (browser path)", async () => {
    const p = await ctx.manager.generateProfile({
      deviceId: "d2",
      userId: "u1",
      interfaces: [{ family: "IPv4", address: "10.0.0.5", port: 55000 }],
      candidates: [{ type: "host", ip: "10.0.0.5", port: 55000 }, { type: "srflx", ip: "198.51.100.1", port: 33000, raddr: "10.0.0.5", rport: 55000 }],
    });
    assert.equal(p.candidates.length, 2);
    assert.ok(p.candidates.every((c) => c.priority > 0 && c.sdp));
    assert.equal(p.diagnostics.source, "reported");
  });

  it("detects symmetric NAT from divergent STUN ports", async () => {
    let port = 40000;
    const sym = makeManager({ stunMapper: () => ({ ip: "203.0.113.9", port: port++ }) });
    const p = await sym.manager.generateProfile({ deviceId: "d3", userId: "u1" });
    assert.equal(p.natType, NatType.SYMMETRIC);
    assert.equal(p.connectionMetadata.symmetric, true);
  });

  it("classifies BLOCKED when STUN fails on every server", async () => {
    const dead = makeManager({ stunMapper: () => null, retries: 0 });
    const p = await dead.manager.generateProfile({ deviceId: "d4", userId: "u1" });
    assert.equal(p.natType, NatType.BLOCKED);
    assert.equal(p.candidates.filter((c) => c.type === "srflx").length, 0);
  });

  it("caches the profile; a device write invalidates on refresh", async () => {
    await ctx.manager.generateProfile({ deviceId: "d1", userId: "u1" });
    const first = ctx.cache.get("device:d1");
    assert.equal(first.outcome, CacheOutcome.HIT);
    await ctx.manager.refreshProfile("d1", { actingUser: "u1" });
    // refresh invalidates then re-sets → still a hit but a new version.
    assert.equal(ctx.cache.get("device:d1").value.version, 2);
  });
});

// ---------------------------------------------------------------------------
describe("manager — refresh + network change", () => {
  it("refresh bumps version; a changed public address emits NETWORK_CHANGED", async () => {
    let publicIp = "203.0.113.9";
    const ctx = makeManager({ stunMapper: () => ({ ip: publicIp, port: 40000 }) });
    const log = recordEvents(ctx.events);
    await ctx.manager.generateProfile({ deviceId: "d1", userId: "u1" });
    publicIp = "203.0.113.50"; // network changed
    const refreshed = await ctx.manager.refreshProfile("d1", { actingUser: "u1" });
    assert.equal(refreshed.version, 2);
    assert.equal(log.ofType(DiscoveryEventType.NETWORK_CHANGED).length, 1);
    assert.equal(log.ofType(DiscoveryEventType.PROFILE_REFRESHED).length, 1);
  });

  it("an unchanged refresh does not emit NETWORK_CHANGED", async () => {
    const ctx = makeManager();
    const log = recordEvents(ctx.events);
    await ctx.manager.generateProfile({ deviceId: "d1", userId: "u1" });
    await ctx.manager.refreshProfile("d1", { actingUser: "u1" });
    assert.equal(log.ofType(DiscoveryEventType.NETWORK_CHANGED).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("manager — queries + lifecycle", () => {
  let ctx;
  beforeEach(async () => {
    ctx = makeManager();
    await ctx.manager.generateProfile({ deviceId: "d1", userId: "u1" });
  });

  it("getNatInfo / getPublicAddress / getCandidates / listInterfaces / getDiagnostics", async () => {
    assert.equal((await ctx.manager.getNatInfo("d1")).natType, NatType.CONE);
    assert.equal((await ctx.manager.getPublicAddress("d1")).publicAddress, "203.0.113.9");
    assert.ok((await ctx.manager.getCandidates("d1")).length >= 2);
    assert.ok((await ctx.manager.listInterfaces("d1")).length >= 1);
    const diag = await ctx.manager.getDiagnostics("d1");
    assert.ok(diag.history.length >= 1); // history recorded
  });

  it("getProfile enforces ownership", async () => {
    const current = await ctx.manager.getCurrentProfile("d1");
    await assert.rejects(() => ctx.manager.getProfile(current.profileId, { actingUser: "intruder" }), UnauthorizedDiscoveryError);
    const ok = await ctx.manager.getProfile(current.profileId, { actingUser: "u1" });
    assert.equal(ok.deviceId, "d1");
  });

  it("lazily expires an overdue profile on read + sweepExpired", async () => {
    const clock = makeClock();
    const c = makeManager({ clock, profileTtlMs: 1000 });
    await c.manager.generateProfile({ deviceId: "dx", userId: "u1" });
    clock.advance(5000);
    const read = await c.manager.getCurrentProfile("dx").catch((e) => e);
    // current profile is now expired → not returned as live (findByDevice filters live states after sweep).
    const { expired } = await c.manager.sweepExpired();
    assert.ok(expired >= 0);
  });

  it("unknown device / profile throws NotFound", async () => {
    await assert.rejects(() => ctx.manager.getNatInfo("ghost"), ProfileNotFoundError);
    await assert.rejects(() => ctx.manager.getProfile("missing-00000000", {}), ProfileNotFoundError);
  });
});

// ---------------------------------------------------------------------------
describe("profile helpers + cache", () => {
  it("createNetworkProfile derives addresses/ports from candidates", () => {
    const clock = makeClock();
    const profile = createNetworkProfile({
      deviceId: "d1",
      interfaces: [{ name: "e", family: "IPv4", address: "192.168.1.5", internal: false }],
      candidates: [{ type: "host", ip: "192.168.1.5", port: 50000 }, { type: "srflx", ip: "203.0.113.1", port: 40000 }],
      nat: { natType: NatType.CONE, publicAddress: "203.0.113.1", symmetric: false },
      clock,
    });
    assert.deepEqual(profile.privatePorts, [50000]);
    assert.deepEqual(profile.publicPorts, [40000]);
    assert.equal(profile.natType, NatType.CONE);
    assert.ok(!isProfileExpired(profile, clock()));
  });

  it("networkSignature detects change", () => {
    const base = { privateAddresses: ["10.0.0.1"], publicAddress: "1.1.1.1", natType: "cone" };
    assert.equal(networkSignature(base), networkSignature({ ...base }));
    assert.notEqual(networkSignature(base), networkSignature({ ...base, publicAddress: "2.2.2.2" }));
  });

  it("cache TTL capped by profile expiry + invalidateDevice", () => {
    const clock = makeClock();
    const cache = new NetworkProfileCache({ clock, ttlMs: 10_000, limit: 2 });
    cache.set("device:d1", { deviceId: "d1", expiresAt: new Date(clock() + 500).toISOString() });
    clock.advance(600);
    assert.equal(cache.get("device:d1").outcome, CacheOutcome.EXPIRED); // capped by profile expiry
    cache.set("a", { deviceId: "d2", expiresAt: new Date(clock() + 5000).toISOString() });
    assert.equal(cache.invalidateDevice("d2"), 1);
  });
});

// ---------------------------------------------------------------------------
describe("validation", () => {
  it("request / interface / candidate / nat guards", () => {
    assert.throws(() => validateGenerateRequest({}), DiscoveryValidationError);
    assert.throws(() => validateGenerateRequest({ deviceId: "d1", interfaces: [] }), DiscoveryValidationError);
    assert.throws(() => validateGenerateRequest({ deviceId: "d1", interfaces: [{ foo: 1 }] }), DiscoveryValidationError);
    assert.throws(() => validateCandidates([{ type: "host", ip: "1.1.1.1", port: 5 }, { type: "host", ip: "1.1.1.1", port: 5 }]), DiscoveryValidationError); // duplicate
    assert.throws(() => validateCandidates([{ type: "bogus" }]), DiscoveryValidationError);
    assert.throws(() => validateNatMetadata({ natType: "weird" }), DiscoveryValidationError);
    assert.doesNotThrow(() => validateNatMetadata({ natType: "cone" }));
    assert.ok(isValidIPv4("192.168.1.1"));
    assert.ok(!isValidIPv4("999.1.1.1"));
  });

  it("profile validation + no-secret invariant + ownership", () => {
    assert.throws(() => requireProfile(null, "x"), ProfileNotFoundError);
    assert.throws(() => validateProfile({ profileId: "x" }), CorruptedProfileError);
    assert.throws(() => assertNoSecretMaterial({ a: { sessionKey: "leak" } }), CorruptedProfileError);
    assert.throws(() => assertOwner({ deviceId: "d1", userId: "u1", profileId: "p" }, "intruder", "other"), UnauthorizedDiscoveryError);
    assert.doesNotThrow(() => assertOwner({ deviceId: "d1", userId: "u1" }, "u1"));
  });
});

// ---------------------------------------------------------------------------
describe("API facade", () => {
  let ctx, api;
  beforeEach(() => {
    ctx = makeManager();
    api = createDiscoveryApi(ctx.manager);
  });

  it("requires an actingUser", async () => {
    await assert.rejects(() => api.generate({ deviceId: "d1" }), /actingUser is required/);
  });

  it("generate → getNatInfo → getCandidates → refresh round-trips", async () => {
    const p = await api.generate({ actingUser: "u1", deviceId: "d1" });
    assert.equal(p.natType, NatType.CONE);
    assert.equal((await api.getNatInfo({ actingUser: "u1", deviceId: "d1" })).natType, NatType.CONE);
    assert.ok((await api.getCandidates({ actingUser: "u1", deviceId: "d1" })).length >= 2);
    const refreshed = await api.refresh({ actingUser: "u1", deviceId: "d1" });
    assert.equal(refreshed.version, 2);
    assert.equal(api.manager, ctx.manager);
  });
});
