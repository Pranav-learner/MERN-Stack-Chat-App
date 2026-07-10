import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ForwardSecrecyEventType, GenerationStatus } from "../types/types.js";
import {
  ForwardSecrecyError,
  KeyStoreRequiredError,
  ForwardSecrecyStateError,
  RollbackDetectedError,
  ReplayDetectedError,
  EvolutionFailedError,
  GenerationNotFoundError,
  SessionOwnershipError,
} from "../errors.js";
import { makeManager, start, captureEvents, makeSecret, makeSessionId } from "./helpers.js";

describe("ForwardSecrecyManager — start", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("starts FS at generation 0 with an active key and no key material in the DTO", async () => {
    const { seen } = captureEvents(ctx.events);
    const dto = await start(ctx.manager);
    assert.equal(dto.started, true);
    assert.equal(dto.currentGeneration, 0);
    assert.equal(dto.generations.length, 1);
    assert.equal(dto.generations[0].status, GenerationStatus.ACTIVE);
    assert.ok(dto.generations[0].keyId);
    assert.equal(dto.security.forwardSecrecy, true);
    assert.equal(dto.security.oneWayChain, true);
    assert.equal(dto.security.doubleRatchet, false);
    // DTO carries NO secrets
    assert.equal(JSON.stringify(dto).toLowerCase().includes("secret"), false);
    assert.equal(JSON.stringify(dto).toLowerCase().includes("encryptionkey"), false);
    assert.ok(seen.types().includes(ForwardSecrecyEventType.FORWARD_SECRECY_STARTED));
    assert.ok(seen.types().includes(ForwardSecrecyEventType.GENERATION_ACTIVATED));
    // device-local keys exist
    assert.ok(ctx.manager.resolveEncryptionKeys(dto.sessionId).keyId);
  });

  it("requires a key store (device mode) + rejects double start", async () => {
    const descriptor = makeManager({ descriptorMode: true }).manager;
    await assert.rejects(() => start(descriptor), KeyStoreRequiredError);
    await start(ctx.manager);
    await assert.rejects(() => start(ctx.manager), ForwardSecrecyStateError);
  });

  it("enforces session ownership when actingUser is supplied", async () => {
    await assert.rejects(() => start(ctx.manager, { actingUser: "carol" }), SessionOwnershipError);
  });
});

describe("ForwardSecrecyManager — evolve (key evolution + destruction)", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager({ retainedGenerations: 1 });
  });

  it("evolves to fresh keys and supersedes the old generation", async () => {
    const { seen } = captureEvents(ctx.events);
    const s = await start(ctx.manager);
    const gen0KeyId = s.generations[0].keyId;
    const gen0Keys = ctx.manager.resolveEncryptionKeys(s.sessionId);
    const gen0Enc = Buffer.from(gen0Keys.encryptionKey);

    const dto = await ctx.manager.evolve(s.sessionId, { reason: "rotation", trigger: "manual" });
    assert.equal(dto.currentGeneration, 1);
    const active = dto.generations.find((g) => g.status === GenerationStatus.ACTIVE);
    assert.equal(active.generation, 1);
    assert.notEqual(active.keyId, gen0KeyId, "fresh key id");
    // current encryption keys changed
    assert.notEqual(ctx.manager.resolveEncryptionKeys(s.sessionId).keyId, gen0KeyId);
    // gen 0 marked superseded (retained window = 1, so its keys still exist for decrypt)
    const gen0 = dto.generations.find((g) => g.generation === 0);
    assert.equal(gen0.status, GenerationStatus.SUPERSEDED);
    // never reuses an evolved key
    assert.ok(!ctx.manager.resolveEncryptionKeys(s.sessionId).encryptionKey.equals(gen0Enc));

    const types = seen.types();
    assert.ok(types.includes(ForwardSecrecyEventType.GENERATION_ADVANCED));
    assert.ok(types.includes(ForwardSecrecyEventType.KEYS_DESTROYED));
    assert.ok(types.includes(ForwardSecrecyEventType.EVOLUTION_COMPLETED));
    assert.ok(types.includes(ForwardSecrecyEventType.TRANSPORT_UPDATED));
  });

  it("destroys the previous generation's keys once it ages out of the retain window", async () => {
    const strict = makeManager({ retainedGenerations: 0 });
    const s = await start(strict.manager);
    const gen0Keys = strict.manager.resolveEncryptionKeys(s.sessionId);
    await strict.manager.evolve(s.sessionId);
    // retain=0 → gen 0 keys destroyed immediately: the buffer was zero-filled
    assert.ok(gen0Keys.encryptionKey.every((b) => b === 0), "gen 0 keys wiped");
    // and cannot be resolved for decryption anymore
    assert.equal(strict.manager.resolveDecryptionKeys(s.sessionId, { keyId: gen0Keys.keyId }), null);
    const dto = await strict.manager.getState(s.sessionId);
    assert.equal(dto.generations.find((g) => g.generation === 0).status, GenerationStatus.DESTROYED);
    assert.ok(dto.destructions.length >= 1);
  });

  it("advances many generations monotonically with distinct key ids", async () => {
    const s = await start(ctx.manager);
    const keyIds = new Set([s.generations[0].keyId]);
    for (let i = 0; i < 10; i++) {
      const dto = await ctx.manager.evolve(s.sessionId, { reason: `r${i}` });
      keyIds.add(dto.generations.find((g) => g.status === GenerationStatus.ACTIVE).keyId);
    }
    assert.equal(keyIds.size, 11, "11 distinct generation key ids");
    assert.equal((await ctx.manager.getStatus(s.sessionId)).currentGeneration, 10);
  });

  it("two peers with the same root evolve to identical keys at each generation", async () => {
    const secret = makeSecret(42);
    const peerA = makeManager().manager;
    const peerB = makeManager().manager;
    const a0 = await start(peerA, { rootSecret: secret });
    const b0 = await start(peerB, { rootSecret: secret });
    assert.equal(a0.generations[0].keyId, b0.generations[0].keyId);
    const a1 = await peerA.evolve(a0.sessionId);
    const b1 = await peerB.evolve(b0.sessionId);
    assert.equal(
      a1.generations.find((g) => g.generation === 1).keyId,
      b1.generations.find((g) => g.generation === 1).keyId,
    );
  });
});

describe("ForwardSecrecyManager — rollback / replay / consistency", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("rejects a replayed generation via the metadata guard", async () => {
    const s = await start(ctx.manager);
    // Inject a phantom generation-1 record WITHOUT advancing currentGeneration, so the
    // next advance (0 → 1) would replay an existing generation.
    const state = await ctx.forwardSecrecy.findBySessionId(s.sessionId);
    await ctx.forwardSecrecy.update(s.sessionId, {
      generations: [...state.generations, { generation: 1, keyId: "phantom", status: "active" }],
    });
    await assert.rejects(() => ctx.manager.evolve(s.sessionId), ReplayDetectedError);
  });

  it("rejects when the key store and metadata generations disagree", async () => {
    const s = await start(ctx.manager);
    // store says gen 5, metadata says gen 0 → inconsistent
    ctx.keyStore._vault.get(s.sessionId).currentGeneration = 5;
    await assert.rejects(() => ctx.manager.evolve(s.sessionId), ForwardSecrecyStateError);
  });

  it("a failed derivation destroys intermediate material + records EVOLUTION_FAILED", async () => {
    const { seen } = captureEvents(ctx.events);
    const s = await start(ctx.manager);
    // Force evolveChain to fail by emptying the stored chain secret.
    ctx.keyStore._vault.get(s.sessionId).chainSecret = Buffer.alloc(0);
    await assert.rejects(() => ctx.manager.evolve(s.sessionId), EvolutionFailedError);
    assert.ok(seen.types().includes(ForwardSecrecyEventType.EVOLUTION_FAILED));
    // metadata still at gen 0 (evolution did not commit)
    assert.equal((await ctx.manager.getStatus(s.sessionId)).currentGeneration, 0);
    const audit = await ctx.manager.getAudit(s.sessionId);
    assert.ok(audit.some((a) => a.action === "evolution-failed"));
  });
});

describe("ForwardSecrecyManager — teardown + descriptor mode + errors", () => {
  it("destroy wipes all key material and marks generations destroyed", async () => {
    const ctx = makeManager();
    const s = await start(ctx.manager);
    await ctx.manager.evolve(s.sessionId);
    const dto = await ctx.manager.destroy(s.sessionId, { reason: "logout" });
    assert.equal(dto.started, false);
    assert.ok(dto.generations.every((g) => g.status === GenerationStatus.DESTROYED));
    assert.equal(ctx.keyStore.has(s.sessionId), false);
    assert.throws(() => ctx.manager.resolveEncryptionKeys(s.sessionId), Error); // no keys → throws / null
  });

  it("descriptor mode records device-reported evolutions (no keys)", async () => {
    const server = makeManager({ descriptorMode: true }).manager;
    const reg = await server.register({ sessionId: makeSessionId(1), handshakeId: "hs", participants: ["a", "b"], keyId: "k0" });
    assert.equal(reg.currentGeneration, 0);
    const evolved = await server.recordEvolution(makeSessionId(1), { generation: 1, keyId: "k1", trigger: "manual" });
    assert.equal(evolved.currentGeneration, 1);
    assert.equal(evolved.generations.find((g) => g.generation === 0).status, GenerationStatus.SUPERSEDED);
    // descriptor mode cannot derive keys
    await assert.rejects(() => server.evolve(makeSessionId(1)), KeyStoreRequiredError);
    // re-reporting the current generation is a rollback (forward-only)
    await assert.rejects(() => server.recordEvolution(makeSessionId(1), { generation: 1 }), RollbackDetectedError);
  });

  it("unknown session raises GenerationNotFoundError; errors carry code + status", async () => {
    const ctx = makeManager();
    await assert.rejects(() => ctx.manager.getState(makeSessionId(99)), GenerationNotFoundError);
    assert.equal(await ctx.manager.findState(makeSessionId(99)), null);
    try {
      await ctx.manager.evolve(makeSessionId(99));
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof ForwardSecrecyError);
      assert.equal(typeof e.code, "string");
    }
  });
});
