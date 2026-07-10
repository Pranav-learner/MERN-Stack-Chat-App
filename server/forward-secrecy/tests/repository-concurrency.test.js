import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryForwardSecrecyRepository } from "../repository/inMemoryForwardSecrecyRepository.js";
import { toPublicForwardSecrecy, toForwardSecrecyStatus } from "../serialization/serializer.js";
import { GenerationNotFoundError } from "../errors.js";
import { GenerationStatus } from "../types/types.js";
import { makeManager, start, makeSecret, makeSessionId } from "./helpers.js";

describe("forward-secrecy repository — in-memory contract", () => {
  let repo, reset;
  beforeEach(() => {
    ({ forwardSecrecy: repo, reset } = createInMemoryForwardSecrecyRepository());
  });

  it("create/find/update/delete round-trips + deep-copies", async () => {
    const state = { sessionId: "session-000001", currentGeneration: 0, generations: [], destructions: [], audit: [], security: {} };
    await repo.create(state);
    const got = await repo.findBySessionId("session-000001");
    got.currentGeneration = 99;
    assert.equal((await repo.findBySessionId("session-000001")).currentGeneration, 0, "store not mutated");
    await repo.update("session-000001", { currentGeneration: 2 });
    assert.equal((await repo.findBySessionId("session-000001")).currentGeneration, 2);
    assert.equal(await repo.delete("session-000001"), true);
    assert.equal(await repo.findBySessionId("session-000001"), null);
  });

  it("update on a missing session throws; findByGeneration + listAll filter", async () => {
    await assert.rejects(() => repo.update("session-000009", {}), GenerationNotFoundError);
    await repo.create({ sessionId: "session-000001", currentGeneration: 0 });
    await repo.create({ sessionId: "session-000002", currentGeneration: 3 });
    assert.equal((await repo.findByGeneration(1)).length, 1);
    assert.equal((await repo.listAll()).length, 2);
    reset();
    assert.equal((await repo.listAll()).length, 0);
  });
});

describe("forward-secrecy serializer", () => {
  it("public DTO whitelists metadata + counts live generations; strips secrets", () => {
    const state = {
      sessionId: "session-000001",
      started: true,
      currentGeneration: 1,
      generations: [
        { generation: 0, keyId: "k0", status: GenerationStatus.SUPERSEDED },
        { generation: 1, keyId: "k1", status: GenerationStatus.ACTIVE },
      ],
      destructions: [{ scope: "chain-secret", at: "t" }],
      security: { forwardSecrecy: true },
      audit: [{ action: "x" }],
    };
    const dto = toPublicForwardSecrecy(state);
    assert.equal(dto.liveGenerations, 2);
    assert.equal("audit" in dto, false);
    assert.equal("audit" in toPublicForwardSecrecy(state, { includeAudit: true }), true);
    const status = toForwardSecrecyStatus(state);
    assert.equal(status.activeKeyId, "k1");
    assert.equal(status.forwardSecrecy, true);
  });
});

describe("forward-secrecy — concurrency, scale, stress, regression", () => {
  it("many concurrent sessions evolve independently with distinct key material", async () => {
    const ctx = makeManager();
    const N = 60;
    await Promise.all(Array.from({ length: N }, (_, i) => start(ctx.manager, { sessionId: makeSessionId(i), handshakeId: `hs-${i}`, seed: i })));
    await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.evolve(makeSessionId(i))));
    const keyIds = new Set();
    for (let i = 0; i < N; i++) keyIds.add(ctx.manager.resolveEncryptionKeys(makeSessionId(i)).keyId);
    assert.equal(keyIds.size, N, "every session has distinct current keys");
    assert.equal(ctx.keyStore.size, N);
  });

  it("stress: 100 sequential evolutions keep the store bounded (retention window)", async () => {
    const ctx = makeManager({ retainedGenerations: 2 });
    const s = await start(ctx.manager);
    for (let i = 0; i < 100; i++) await ctx.manager.evolve(ctx.manager ? s.sessionId : null);
    assert.equal((await ctx.manager.getStatus(s.sessionId)).currentGeneration, 100);
    // only the retained window of derived keys is held (current + 2 previous = 3)
    assert.equal(ctx.keyStore.heldGenerations(s.sessionId).length, 3);
    assert.deepEqual(ctx.keyStore.heldGenerations(s.sessionId), [98, 99, 100]);
  });

  it("regression: destroy then restart the same session works with fresh material", async () => {
    const ctx = makeManager();
    const s = await start(ctx.manager, { rootSecret: makeSecret(1) });
    const firstKeyId = s.generations[0].keyId;
    await ctx.manager.destroy(s.sessionId);
    await ctx.manager.deleteState(s.sessionId);
    // a brand-new root → a different generation-0 key id
    const restarted = await start(ctx.manager, { sessionId: s.sessionId, rootSecret: makeSecret(2) });
    assert.notEqual(restarted.generations[0].keyId, firstKeyId);
    assert.equal(restarted.currentGeneration, 0);
  });
});
