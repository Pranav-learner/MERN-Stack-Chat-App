/**
 * Concurrency + repositories + validation hardening + large-group stress (Layer 10, Sprint 2). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeEngine, deviceId } from "./helpers.js";
import { assertNoSecretMaterial, validateRepository } from "../validators/validators.js";
import { createInMemoryGroupCommRepository } from "../repository/inMemoryGroupCommRepository.js";

describe("validation hardening", () => {
  it("rejects secret/key/plaintext material anywhere in a record", () => {
    assert.throws(() => assertNoSecretMaterial({ meta: { groupKey: "leak" } }), /secret\/key\/plaintext/i);
    assert.throws(() => assertNoSecretMaterial({ a: { b: { plaintext: "hi" } } }), /plaintext/i);
    assert.doesNotThrow(() => assertNoSecretMaterial({ ciphertext: "opaque", contentHash: "abc", fingerprint: "def" }));
  });

  it("validateRepository requires the store contract", () => {
    assert.throws(() => validateRepository({}), /missing the 'keys'/i);
    assert.doesNotThrow(() => validateRepository(createInMemoryGroupCommRepository()));
  });
});

describe("in-memory repository contracts", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryGroupCommRepository();
  });

  it("keys: create/findActive/findByVersion/list/update", async () => {
    await repo.keys.create({ groupId: "g", keyVersion: 1, fingerprint: "f", state: "active" });
    await repo.keys.create({ groupId: "g", keyVersion: 2, fingerprint: "e", state: "active" });
    assert.equal((await repo.keys.findActive("g")).keyVersion, 2, "highest active wins");
    await repo.keys.update("g", 1, { state: "superseded" });
    assert.equal((await repo.keys.findByVersion("g", 1)).state, "superseded");
    assert.equal((await repo.keys.listByGroup("g")).length, 2);
  });

  it("messages: create/find/listByGroup/listAfter", async () => {
    await repo.messages.create({ messageId: "m1", groupId: "g", createdAt: "2024-01-01T00:00:00Z" });
    await repo.messages.create({ messageId: "m2", groupId: "g", createdAt: "2024-01-02T00:00:00Z" });
    assert.equal((await repo.messages.findById("m1")).messageId, "m1");
    assert.equal((await repo.messages.listByGroup("g")).length, 2);
    assert.deepEqual((await repo.messages.listAfter("g", "2024-01-01T12:00:00Z")).map((m) => m.messageId), ["m2"]);
  });

  it("pendingQueue: enqueue/drainDevice/count", async () => {
    await repo.pendingQueue.enqueue({ groupId: "g", deviceId: "d1", messageId: "m1" });
    await repo.pendingQueue.enqueue({ groupId: "g", deviceId: "d1", messageId: "m2" });
    await repo.pendingQueue.enqueue({ groupId: "g", deviceId: "d2", messageId: "m3" });
    assert.equal(await repo.pendingQueue.count("g"), 3);
    const drained = await repo.pendingQueue.drainDevice("g", "d1");
    assert.equal(drained.length, 2);
    assert.equal(await repo.pendingQueue.count("g"), 1);
  });

  it("deep-copies records (no mutation by reference)", async () => {
    await repo.keys.create({ groupId: "g", keyVersion: 1, fingerprint: "f", distribution: [{ memberId: "a", delivered: false }] });
    const k = await repo.keys.findByVersion("g", 1);
    k.distribution[0].delivered = true;
    assert.equal((await repo.keys.findByVersion("g", 1)).distribution[0].delivered, false);
  });
});

describe("concurrent messaging + rekey", () => {
  let ctx;
  beforeEach(async () => {
    ctx = makeEngine({ members: ["alice", "bob", "carol"], online: new Set([deviceId("alice"), deviceId("bob"), deviceId("carol")]) });
    await ctx.api.establishGroupKey({ groupId: "g", actorId: "alice" });
  });

  it("delivers many concurrent messages without loss or duplicate legs", async () => {
    const N = 40;
    const sends = Array.from({ length: N }, (_, i) => ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: `ENC(${i})` }));
    const results = await Promise.all(sends);
    assert.equal(results.length, N);
    // every message got its own plan; each plan fans out to bob + carol (2 legs), alice skipped.
    for (const r of results) assert.equal(r.fanout.summary.total, 2);
    const msgs = await ctx.api.listMessages({ groupId: "g", limit: 100 });
    assert.equal(msgs.length, N);
  });

  it("serializes concurrent rekeys into monotonic versions", async () => {
    const rotations = Array.from({ length: 10 }, (_, i) => ctx.engine.rotateGroupKey({ groupId: "g", actorId: "system", trigger: i % 2 ? "member-leave" : "member-join", affectedMember: "bob" }));
    await Promise.all(rotations);
    const keys = await ctx.api.listKeys({ groupId: "g" });
    const versions = keys.map((k) => k.keyVersion).sort((a, b) => a - b);
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "no lost or duplicated versions");
    const active = keys.filter((k) => k.state === "active");
    assert.equal(active.length, 1, "exactly one active key");
    assert.equal(active[0].keyVersion, 11);
  });
});

describe("large group stress (1000+ members)", () => {
  it("fans out to a large group in one plan", async () => {
    const members = Array.from({ length: 1200 }, (_, i) => `m${i}`);
    const online = new Set(members.map((m) => deviceId(m)));
    const ctx = makeEngine({ members, online });
    await ctx.api.establishGroupKey({ groupId: "big", actorId: "m0" });
    const r = await ctx.api.sendGroupMessage({ groupId: "big", senderId: "m0", senderDeviceId: deviceId("m0"), ciphertext: "ENC(broadcast)" });
    assert.equal(r.fanout.summary.total, 1199, "one leg per member except the sender");
    assert.equal(r.fanout.summary.delivered, 1199);
  });
});
