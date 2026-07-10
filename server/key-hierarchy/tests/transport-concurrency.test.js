import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptWithHierarchy, decryptWithHierarchy, createHierarchyTransport, resolveActiveSendingChain } from "../transport/transportIntegration.js";
import { decryptMessage } from "../../secure-transport/decryptor/decryptor.js";
// Sprint 2 forward-secrecy (device) via specific files — avoids mongoose.
import { ForwardSecrecyManager } from "../../forward-secrecy/manager/forwardSecrecyManager.js";
import { ForwardSecrecyKeyStore } from "../../forward-secrecy/keystore/forwardSecrecyKeyStore.js";
import { createInMemoryForwardSecrecyRepository } from "../../forward-secrecy/repository/inMemoryForwardSecrecyRepository.js";
import { makeManager, makeSecret, makeSessionId } from "./helpers.js";

/** Build a device FS manager + establish FS for a session; return the ratchetMaterial. */
async function startFs(sessionId, seed = 1) {
  const fs = new ForwardSecrecyManager({ ...createInMemoryForwardSecrecyRepository(), keyStore: new ForwardSecrecyKeyStore() });
  await fs.start({ sessionId, handshakeId: "hs-000001", participants: ["alice", "bob"], rootSecret: makeSecret(seed) });
  const rootSecret = fs.resolveEncryptionKeys(sessionId).ratchetMaterial; // the Layer 5 seam
  return { fs, rootSecret };
}

describe("transport integration — resolution path + extension point", () => {
  it("without a message-key hook, encryption falls back to forward-secrecy keys (round-trips)", async () => {
    const ctx = makeManager();
    const sid = makeSessionId(1);
    const { fs, rootSecret } = await startFs(sid);
    await ctx.manager.establish({ sessionId: sid, role: "initiator", rootSecret });

    const payload = await encryptWithHierarchy({ text: "hello" }, { sessionId: sid }, { chainManager: ctx.manager, forwardSecrecy: fs });
    const msg = decryptWithHierarchy(payload, { forwardSecrecy: fs });
    assert.deepEqual(msg, { text: "hello" });
    // the resolution path resolves Session → Root → Sending Chain
    const path = await resolveActiveSendingChain(ctx.manager, sid);
    assert.ok(path.rootKeyId);
    assert.equal(path.sendingChain.index, 0);
  });

  it("a message-key hook (Sprint 5 shape) derives per-message keys from the sending chain", async () => {
    const ctx = makeManager();
    const sid = makeSessionId(2);
    const { fs, rootSecret } = await startFs(sid, 2);
    await ctx.manager.establish({ sessionId: sid, role: "initiator", rootSecret });

    // A stand-in message-key deriver: HKDF(chainKey) → {encryptionKey, macKey, keyId}.
    const messageKeyHook = ({ chainKey, index }) => {
      const enc = Buffer.from(crypto.hkdfSync("sha256", chainKey, Buffer.from("mk"), Buffer.from(`enc|${index}`), 32));
      const mac = Buffer.from(crypto.hkdfSync("sha256", chainKey, Buffer.from("mk"), Buffer.from(`mac|${index}`), 32));
      return { encryptionKey: enc, macKey: mac, keyId: `mk-${index}-${crypto.createHash("sha256").update(enc).digest("hex").slice(0, 8)}` };
    };
    const transport = createHierarchyTransport({ chainManager: ctx.manager, forwardSecrecy: fs, messageKeyHook });
    assert.equal(transport.perMessageKeys, true);

    const payload = await transport.encrypt({ text: "via chain" }, { sessionId: sid });
    assert.match(payload.keyId, /^mk-0-/, "sealed under a per-message key, not the FS session key");
    // decrypt manually with the same deterministic message key (both peers derive identically)
    const chain = ctx.manager.resolveSendingChainKey(sid);
    const keys = messageKeyHook({ chainKey: chain.chainKey, index: chain.index });
    assert.deepEqual(decryptMessage(payload, keys), { text: "via chain" });
  });
});

describe("concurrency, multi-device, stress, regression", () => {
  it("many concurrent sessions establish with distinct root/chain material", async () => {
    const ctx = makeManager();
    const N = 50;
    const dtos = await Promise.all(
      Array.from({ length: N }, (_, i) => ctx.manager.establish({ sessionId: makeSessionId(i), handshakeId: `hs-${i}`, role: "initiator", rootSecret: makeSecret(i) })),
    );
    assert.equal(new Set(dtos.map((d) => d.rootKey.rootKeyId)).size, N);
    assert.equal(new Set(dtos.map((d) => d.sendingChain.fingerprint)).size, N);
    assert.equal(ctx.keyStore.size, N);
  });

  it("multi-device: initiator + responder advance sending chains independently", async () => {
    const secret = makeSecret(7);
    const initiator = makeManager().manager;
    const responder = makeManager().manager;
    const a = await initiator.establish({ sessionId: makeSessionId(1), role: "initiator", rootSecret: secret });
    const b = await responder.establish({ sessionId: makeSessionId(1), role: "responder", rootSecret: secret });
    await initiator.advanceSendingChain(a.sessionId);
    await initiator.advanceSendingChain(a.sessionId);
    assert.equal((await initiator.getStatus(a.sessionId)).sendingIndex, 2);
    assert.equal((await responder.getStatus(b.sessionId)).sendingIndex, 0, "peer's chains advance independently");
  });

  it("stress: 100 sending advances stay monotonic with distinct fingerprints", async () => {
    const ctx = makeManager();
    const dto = await ctx.manager.establish({ sessionId: makeSessionId(1), role: "initiator", rootSecret: makeSecret(1) });
    const sid = dto.sessionId;
    const fps = new Set();
    for (let i = 0; i < 100; i++) fps.add((await ctx.manager.advanceSendingChain(sid)).sendingChain.fingerprint);
    assert.equal(fps.size, 100);
    assert.equal((await ctx.manager.getStatus(sid)).sendingIndex, 100);
  });

  it("regression: establish → advance → reroot → advance again", async () => {
    const ctx = makeManager();
    const dto = await ctx.manager.establish({ sessionId: makeSessionId(1), role: "initiator", rootSecret: makeSecret(1), generation: 0 });
    const sid = dto.sessionId;
    await ctx.manager.advanceSendingChain(sid);
    await ctx.manager.reroot(sid, { rootSecret: makeSecret(2), generation: 1 });
    const after = await ctx.manager.advanceSendingChain(sid);
    assert.equal(after.generation, 1);
    assert.equal(after.sendingChain.index, 1);
    assert.equal(after.archivedChains.length, 2);
  });
});
