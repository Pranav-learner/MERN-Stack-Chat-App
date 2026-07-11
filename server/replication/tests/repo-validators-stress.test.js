/**
 * Repository contract, validators, scale, and convergence fuzz (Layer 9, Sprint 2). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, rec, snapshot } from "./helpers.js";
import { createInMemoryReplicationRepository } from "../repository/inMemoryReplicationRepository.js";
import { assertNoPlaintext, validateReplicaRegistration, validateRepository, validateConflictPolicy, FORBIDDEN_KEYS } from "../validators/validators.js";
import { mergeFingerprint } from "../merge/mergeEngine.js";

describe("in-memory repository", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryReplicationRepository();
  });

  it("replicas: upsert/find/findByDevice/listByUser/update/delete", async () => {
    const s = snapshot("r1", { messages: { m1: rec(1, "r1") } });
    await repo.replicas.upsert(s);
    assert.equal((await repo.replicas.findById("r1")).replicaId, "r1");
    assert.equal((await repo.replicas.findByDevice("r1")).replicaId, "r1");
    assert.equal((await repo.replicas.listByUser("u1")).length, 1);
    await repo.replicas.update("r1", { replicaVersion: 9 });
    assert.equal((await repo.replicas.findById("r1")).replicaVersion, 9);
    assert.equal(await repo.replicas.delete("r1"), true);
  });

  it("history stores record + listByReplica", async () => {
    await repo.conflictHistory.record({ sourceReplicaId: "a", targetReplicaId: "b", category: "messages", entityId: "m1", at: new Date(1).toISOString() });
    assert.equal((await repo.conflictHistory.listByReplica("a")).length, 1);
    await repo.mergeHistory.record({ sourceReplicaId: "a", targetReplicaId: "b", at: new Date(2).toISOString() });
    assert.equal((await repo.mergeHistory.listByReplica("b")).length, 1);
  });

  it("stores by deep copy (mutation isolation)", async () => {
    const s = snapshot("r1", { messages: { m1: rec(1, "r1") } });
    await repo.replicas.upsert(s);
    s.categories.messages.m1.version = 999;
    assert.equal((await repo.replicas.findById("r1")).categories.messages.m1.version, 1);
  });
});

describe("validators", () => {
  it("every forbidden key (incl. content/ciphertext/body) is rejected", () => {
    for (const key of FORBIDDEN_KEYS) {
      assert.throws(() => assertNoPlaintext({ a: { [key]: "x" } }), new RegExp(key), `should reject "${key}"`);
    }
  });

  it("cycle-safe deep scan", () => {
    const a = { ok: 1 };
    a.self = a;
    assert.doesNotThrow(() => assertNoPlaintext(a));
  });

  it("validateReplicaRegistration + validateRepository + validateConflictPolicy", () => {
    assert.throws(() => validateReplicaRegistration({}), /device identifier/);
    assert.ok(validateReplicaRegistration({ deviceId: "d", userId: "u" }));
    assert.throws(() => validateRepository({ replicas: { upsert() {} } }), /missing method/);
    assert.throws(() => validateConflictPolicy("telepathy"), /Unknown conflict policy/);
    assert.ok(validateConflictPolicy("merge"));
  });
});

describe("scale", () => {
  it("synchronizes a large replica (3000 messages) to a fresh device", async () => {
    const ctx = makeManager();
    const entities = {};
    for (let i = 0; i < 3000; i++) entities[`m${i}`] = rec(1, "server");
    await ctx.manager.registerReplica({ deviceId: "server", userId: "u1", replicaId: "server", categories: { messages: entities } });
    await ctx.manager.registerReplica({ deviceId: "fresh", userId: "u1", replicaId: "fresh", categories: {} });
    const r = await ctx.manager.replicateDelta({ sourceReplicaId: "server", targetReplicaId: "fresh" });
    assert.equal(r.applied, 3000);
    assert.equal((await ctx.manager.getReplicaStatus({ replicaId: "fresh" })).categories.messages.count, 3000);
  });
});

describe("fuzz: concurrent replicas converge (eventual consistency)", () => {
  it("N replicas with random edits all reach the same state after gossip", async () => {
    function prng(seed) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (let seed = 1; seed <= 8; seed++) {
      const rand = prng(seed);
      const ctx = makeManager();
      const replicas = ["r0", "r1", "r2", "r3"];
      // Each replica independently edits a shared set of entities.
      for (const id of replicas) {
        const categories = { messages: {}, "read-receipts": {} };
        for (let e = 0; e < 6; e++) {
          if (rand() < 0.7) categories.messages[`m${e}`] = rec(1 + Math.floor(rand() * 3), id, `h${id}-${e}-${Math.floor(rand() * 3)}`, new Date(1_700_000_000_000 + Math.floor(rand() * 1e6)).toISOString());
          if (rand() < 0.5) categories["read-receipts"][`rr${e}`] = rec(1, id, `x${id}${e}`, new Date(1_700_000_000_000 + Math.floor(rand() * 1e6)).toISOString(), { readers: { [id]: new Date(1_700_000_000_000 + Math.floor(rand() * 1e6)).toISOString() } });
        }
        await ctx.manager.registerReplica({ deviceId: id, userId: "u1", replicaId: id, categories });
      }
      // Gossip: several rounds of star sync through r0 converge everyone (LWW total order + union semilattice).
      for (let round = 0; round < 3; round++) {
        for (const id of replicas.slice(1)) {
          await ctx.manager.synchronizeReplicas({ sourceReplicaId: id, targetReplicaId: "r0", policy: "last-write-wins" });
        }
        for (const id of replicas.slice(1)) {
          await ctx.manager.synchronizeReplicas({ sourceReplicaId: "r0", targetReplicaId: id, policy: "last-write-wins" });
        }
      }
      // All replicas now share the same converged fingerprint.
      const fps = [];
      for (const id of replicas) fps.push(mergeFingerprint(await ctx.repo.replicas.findById(id)));
      assert.equal(new Set(fps).size, 1, `seed ${seed}: all replicas converged (${new Set(fps).size} distinct states)`);
    }
  });
});
