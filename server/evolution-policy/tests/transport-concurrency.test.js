import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { encryptWithAutoRekey, decryptWithAutoRekey, createAutoRekeyInterceptor } from "../transport/transportIntegration.js";
import { createInMemoryPolicyRepository } from "../repository/inMemoryPolicyRepository.js";
import { toPublicRekeyState, toRekeyStatus } from "../serialization/serializer.js";
import { RekeyNotConfiguredError } from "../errors.js";
import { createMessageCountPolicy, createManualPolicy } from "../policies/policyFactory.js";
import { makeStack, setup, startFs, makeSessionId, makeSecret } from "./helpers.js";

describe("transport integration — transparent auto-rekey", () => {
  let stack;
  beforeEach(() => {
    stack = makeStack();
  });

  it("encrypt records activity and rekeys transparently; ciphertext uses the new generation", async () => {
    const sid = await setup(stack, { policies: [createMessageCountPolicy({ maxMessages: 2 })] });
    const p1 = await encryptWithAutoRekey({ n: 1 }, { sessionId: sid }, { rekeyManager: stack.manager }); // count 1
    const p2 = await encryptWithAutoRekey({ n: 2 }, { sessionId: sid }, { rekeyManager: stack.manager }); // count 2 → rekey
    assert.notEqual(p1.keyId, p2.keyId, "second message sealed under the freshly-evolved generation");
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 1);
  });

  it("messages sent before a rekey still decrypt (retention window); app is oblivious", async () => {
    const sid = await setup(stack, { policies: [createManualPolicy()] });
    const early = await encryptWithAutoRekey({ msg: "before" }, { sessionId: sid }, { rekeyManager: stack.manager });
    assert.deepEqual(decryptWithAutoRekey(early, { rekeyManager: stack.manager }), { msg: "before" });
    await stack.manager.manualRekey(sid); // generation advances under the hood
    const late = await encryptWithAutoRekey({ msg: "after" }, { sessionId: sid }, { rekeyManager: stack.manager });
    assert.deepEqual(decryptWithAutoRekey(late, { rekeyManager: stack.manager }), { msg: "after" });
    // the pre-rekey message still opens (default retention window = 1)
    assert.deepEqual(decryptWithAutoRekey(early, { rekeyManager: stack.manager }), { msg: "before" });
  });

  it("auto-rekey interceptor seals + opens envelopes", async () => {
    const sid = await setup(stack, { policies: [createManualPolicy()] });
    const interceptor = createAutoRekeyInterceptor({ rekeyManager: stack.manager });
    const out = await interceptor.encryptOutbound({ sessionId: sid, payload: { hi: 1 } }, { sessionId: sid });
    assert.equal(out.secured, true);
    const back = interceptor.decryptInbound(out, { sessionId: sid });
    assert.deepEqual(back.payload, { hi: 1 });
  });
});

describe("duplicate + concurrent rekeys at the manager level", () => {
  it("a burst of concurrent message records produces at most one rekey per generation", async () => {
    const stack = makeStack();
    const sid = await setup(stack, { policies: [createMessageCountPolicy({ maxMessages: 1 })] });
    // fire five concurrent sends; message-count=1 means each *could* rekey, but they are
    // serialized + generation-deduped, so the generation advances at most once per settled batch.
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => stack.manager.recordMessage(sid)));
    const gen = (await stack.fs.getStatus(sid)).currentGeneration;
    assert.ok(gen >= 1, "at least one rekey happened");
    assert.equal(results.filter((r) => r.rekeyed).length, gen, "rekeyed count matches generation advances");
  });
});

describe("repository, serializer, stress, regression", () => {
  it("in-memory repo contract round-trips + deep-copies", async () => {
    const { rekeyPolicies: repo, reset } = createInMemoryPolicyRepository();
    await repo.create({ sessionId: "session-000001", config: { enabled: true }, policies: [], executions: [] });
    const got = await repo.findBySessionId("session-000001");
    got.currentGeneration = 9;
    assert.notEqual((await repo.findBySessionId("session-000001")).currentGeneration, 9);
    await repo.update("session-000001", { currentGeneration: 2 });
    assert.equal((await repo.findBySessionId("session-000001")).currentGeneration, 2);
    assert.equal((await repo.findEnabled()).length, 1);
    await assert.rejects(() => repo.update("missing-0001", {}), RekeyNotConfiguredError);
    assert.equal(await repo.delete("session-000001"), true);
    reset();
    assert.equal((await repo.listAll()).length, 0);
  });

  it("serializer whitelists metadata + flags isRekeying", () => {
    const state = { sessionId: "session-000001", policies: [createManualPolicy()], config: { enabled: true }, currentGeneration: 2, pending: { state: "executing" }, rekeyHistory: [], executions: [], security: { automaticRekeying: true } };
    const dto = toPublicRekeyState(state);
    assert.equal(dto.isRekeying, true);
    assert.equal(dto.policies.length, 1);
    assert.equal("audit" in dto, false);
    assert.equal(toRekeyStatus(state).currentGeneration, 2);
  });

  it("stress: 40 sessions each auto-rekey via message-count independently", async () => {
    const stack = makeStack();
    const ids = Array.from({ length: 40 }, (_, i) => makeSessionId(i));
    for (let i = 0; i < ids.length; i++) {
      await startFs(stack.fs, { sessionId: ids[i], seed: i, rootSecret: makeSecret(i) });
      await stack.manager.configure({ sessionId: ids[i], policies: [createMessageCountPolicy({ maxMessages: 1 })] });
    }
    await Promise.all(ids.map((sid) => stack.manager.recordMessage(sid)));
    for (const sid of ids) assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 1);
  });

  it("regression: manual rekey works with cooldown configured (bypasses it)", async () => {
    const stack = makeStack({ cooldownMs: 60_000 });
    const sid = await setup(stack, { policies: [createManualPolicy()], cooldownMs: 60_000 });
    await stack.manager.manualRekey(sid);
    await stack.manager.manualRekey(sid);
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 2);
  });
});
