import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { KeyHierarchyEventType, ChainStatus, RootKeyStatus, ChainDirection } from "../types/types.js";
import {
  KeyHierarchyError,
  KeyStoreRequiredError,
  HierarchyStateError,
  HierarchyNotFoundError,
} from "../errors.js";
import { makeManager, establish, captureEvents, makeSecret, makeSessionId } from "./helpers.js";

describe("ChainManager — establishment", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("establishes root + sending + receiving chains at generation 0; no key bytes in DTO", async () => {
    const { seen } = captureEvents(ctx.events);
    const dto = await establish(ctx.manager);
    assert.equal(dto.generation, 0);
    assert.ok(dto.rootKey.rootKeyId);
    assert.equal(dto.rootKey.status, RootKeyStatus.ACTIVE);
    assert.equal(dto.sendingChain.index, 0);
    assert.equal(dto.receivingChain.index, 0);
    assert.equal(dto.sendingChain.role, "sending");
    assert.equal(dto.receivingChain.role, "receiving");
    assert.notEqual(dto.sendingChain.direction, dto.receivingChain.direction);
    assert.equal(dto.security.hierarchical, true);
    assert.equal(dto.security.perMessageKeys, false);
    // no secrets leak
    assert.equal(JSON.stringify(dto).toLowerCase().includes("secret"), false);
    const types = seen.types();
    assert.ok(types.includes(KeyHierarchyEventType.ROOT_KEY_CREATED));
    assert.equal(types.filter((t) => t === KeyHierarchyEventType.CHAIN_CREATED).length, 2);
    // device keys exist
    assert.ok(Buffer.isBuffer(ctx.manager.resolveSendingChainKey(dto.sessionId).chainKey));
  });

  it("initiator role → sending is i2r; responder role → sending is r2i", async () => {
    const init = await establish(ctx.manager, { sessionId: makeSessionId(1), role: "initiator" });
    const resp = await establish(ctx.manager, { sessionId: makeSessionId(2), role: "responder" });
    assert.equal(init.sendingChain.direction, ChainDirection.I2R);
    assert.equal(resp.sendingChain.direction, ChainDirection.R2I);
  });

  it("two peers derive matching cross-direction chains (interop)", async () => {
    const secret = makeSecret(42);
    const alice = makeManager().manager; // initiator
    const bob = makeManager().manager; // responder
    const a = await establish(alice, { role: "initiator", rootSecret: secret });
    const b = await establish(bob, { role: "responder", rootSecret: secret });
    // alice.sending (i2r) fingerprint == bob.receiving (i2r) fingerprint
    assert.equal(a.sendingChain.fingerprint, b.receivingChain.fingerprint);
    assert.equal(a.receivingChain.fingerprint, b.sendingChain.fingerprint);
    assert.equal(a.rootKey.fingerprint, b.rootKey.fingerprint);
  });

  it("requires a key store; rejects double establish", async () => {
    const descriptor = makeManager({ descriptorMode: true }).manager;
    await assert.rejects(() => establish(descriptor), KeyStoreRequiredError);
    await establish(ctx.manager);
    await assert.rejects(() => establish(ctx.manager), HierarchyStateError);
  });
});

describe("ChainManager — chain evolution", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("advances the sending chain independently of the receiving chain", async () => {
    const { seen } = captureEvents(ctx.events);
    const dto = await establish(ctx.manager);
    const sid = dto.sessionId;
    const sendFp0 = dto.sendingChain.fingerprint;

    const afterSend = await ctx.manager.advanceSendingChain(sid, { reason: "test" });
    assert.equal(afterSend.sendingChain.index, 1);
    assert.equal(afterSend.receivingChain.index, 0, "receiving chain untouched");
    assert.notEqual(afterSend.sendingChain.fingerprint, sendFp0);
    assert.equal(afterSend.sendingChain.history.length, 2);

    const afterRecv = await ctx.manager.advanceReceivingChain(sid);
    assert.equal(afterRecv.receivingChain.index, 1);
    assert.equal(afterRecv.sendingChain.index, 1, "sending chain untouched");
    assert.ok(seen.types().includes(KeyHierarchyEventType.CHAIN_ADVANCED));
    // device key store indexes match the metadata
    assert.equal(ctx.keyStore.sendingIndex(sid), 1);
    assert.equal(ctx.keyStore.receivingIndex(sid), 1);
  });

  it("advances many steps monotonically with distinct fingerprints", async () => {
    const dto = await establish(ctx.manager);
    const sid = dto.sessionId;
    const fps = new Set([dto.sendingChain.fingerprint]);
    for (let i = 0; i < 10; i++) {
      const r = await ctx.manager.advanceSendingChain(sid);
      fps.add(r.sendingChain.fingerprint);
    }
    assert.equal(fps.size, 11);
    assert.equal((await ctx.manager.getStatus(sid)).sendingIndex, 10);
  });

  it("advancing requires a key store (descriptor mode cannot)", async () => {
    const descriptor = makeManager({ descriptorMode: true }).manager;
    await assert.rejects(() => descriptor.advanceSendingChain(makeSessionId(1)), KeyStoreRequiredError);
  });
});

describe("ChainManager — re-root (generation advance)", () => {
  it("re-roots: archives old chains, supersedes root, resets indexes at the new generation", async () => {
    const ctx = makeManager();
    const { seen } = captureEvents(ctx.events);
    const dto = await establish(ctx.manager, { generation: 0 });
    const sid = dto.sessionId;
    await ctx.manager.advanceSendingChain(sid); // index 1
    const oldRootId = dto.rootKey.rootKeyId;

    const rerooted = await ctx.manager.reroot(sid, { rootSecret: makeSecret(2), generation: 1, reason: "rekey" });
    assert.equal(rerooted.generation, 1);
    assert.notEqual(rerooted.rootKey.rootKeyId, oldRootId, "fresh root key");
    assert.equal(rerooted.rootKey.version, 2);
    assert.equal(rerooted.sendingChain.index, 0, "new generation chains reset to index 0");
    assert.equal(rerooted.archivedChains.length, 2, "both previous chains archived");
    assert.ok(rerooted.archivedChains.every((c) => c.status === ChainStatus.ARCHIVED));
    const types = seen.types();
    assert.ok(types.includes(KeyHierarchyEventType.ROOT_KEY_SUPERSEDED));
    assert.ok(types.includes(KeyHierarchyEventType.CHAIN_ARCHIVED));
    // key store re-rooted: fresh chain keys at index 0
    assert.equal(ctx.keyStore.sendingIndex(sid), 0);
  });

  it("rejects a re-root that does not advance the generation", async () => {
    const ctx = makeManager();
    const dto = await establish(ctx.manager, { generation: 0 });
    await assert.rejects(() => ctx.manager.reroot(dto.sessionId, { rootSecret: makeSecret(2), generation: 0 }), HierarchyStateError);
  });
});

describe("ChainManager — validation, destroy, errors", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("validate passes for a healthy hierarchy + emits CHAIN_VALIDATED", async () => {
    const { seen } = captureEvents(ctx.events);
    const dto = await establish(ctx.manager);
    const v = await ctx.manager.validate(dto.sessionId);
    assert.equal(v.valid, true);
    assert.ok(seen.types().includes(KeyHierarchyEventType.CHAIN_VALIDATED));
  });

  it("validate detects a store/metadata index mismatch", async () => {
    const dto = await establish(ctx.manager);
    // advance the store without updating metadata → inconsistent
    ctx.keyStore.advanceSending(dto.sessionId);
    const v = await ctx.manager.validate(dto.sessionId);
    assert.equal(v.valid, false);
  });

  it("destroy wipes all key material + marks everything destroyed", async () => {
    const dto = await establish(ctx.manager);
    const sid = dto.sessionId;
    const out = await ctx.manager.destroy(sid, { reason: "logout" });
    assert.equal(out.rootKey.status, RootKeyStatus.DESTROYED);
    assert.equal(out.sendingChain.status, ChainStatus.DESTROYED);
    assert.equal(ctx.keyStore.has(sid), false);
    assert.throws(() => ctx.manager.resolveSendingChainKey(sid), KeyStoreRequiredError);
  });

  it("unknown session raises HierarchyNotFoundError; errors carry code + status", async () => {
    await assert.rejects(() => ctx.manager.getState(makeSessionId(99)), HierarchyNotFoundError);
    assert.equal(await ctx.manager.findState(makeSessionId(99)), null);
    try {
      await ctx.manager.advanceSendingChain(makeSessionId(99));
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof KeyHierarchyError);
      assert.equal(typeof e.code, "string");
    }
  });
});
