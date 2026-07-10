import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encryptWithForwardSecrecy,
  decryptWithForwardSecrecy,
  createForwardSecrecyKeyProvider,
  createForwardSecrecyInterceptor,
} from "../transport/transportIntegration.js";
import { DestroyedKeyReferenceError } from "../errors.js";
import { makeManager, start, makeSecret } from "./helpers.js";

describe("forward secrecy ↔ secure transport", () => {
  it("encrypts under the current generation and decrypts by keyId (round-trip)", async () => {
    const ctx = makeManager();
    const s = await start(ctx.manager);
    const payload = encryptWithForwardSecrecy({ text: "hello" }, { sessionId: s.sessionId, senderDevice: "devA", receiverDevice: "devB" }, { forwardSecrecy: ctx.manager });
    const message = decryptWithForwardSecrecy(payload, { forwardSecrecy: ctx.manager });
    assert.deepEqual(message, { text: "hello" });
  });

  it("encryption automatically uses the latest generation after an evolution", async () => {
    const ctx = makeManager();
    const s = await start(ctx.manager);
    const p0 = encryptWithForwardSecrecy({ n: 0 }, { sessionId: s.sessionId }, { forwardSecrecy: ctx.manager });
    await ctx.manager.evolve(s.sessionId);
    const p1 = encryptWithForwardSecrecy({ n: 1 }, { sessionId: s.sessionId }, { forwardSecrecy: ctx.manager });
    assert.notEqual(p0.keyId, p1.keyId, "sealed under a fresh generation key");
  });

  it("FORWARD SECRECY: once a generation is destroyed, its old ciphertext can no longer be read", async () => {
    // strict window: a superseded generation is destroyed immediately.
    const secret = makeSecret(11);
    const alice = makeManager({ retainedGenerations: 0 }).manager;
    const bob = makeManager({ retainedGenerations: 0 }).manager;
    const a = await start(alice, { rootSecret: secret });
    const b = await start(bob, { rootSecret: secret });

    // gen 0 traffic, decryptable by the peer.
    const oldCiphertext = encryptWithForwardSecrecy({ secret: "gen0" }, { sessionId: a.sessionId }, { forwardSecrecy: alice });
    assert.deepEqual(decryptWithForwardSecrecy(oldCiphertext, { forwardSecrecy: bob }), { secret: "gen0" });

    // both peers evolve → gen 0 keys destroyed on both sides.
    await alice.evolve(a.sessionId);
    await bob.evolve(b.sessionId);

    // new traffic still flows (uninterrupted secure communication).
    const fresh = encryptWithForwardSecrecy({ secret: "gen1" }, { sessionId: a.sessionId }, { forwardSecrecy: alice });
    assert.deepEqual(decryptWithForwardSecrecy(fresh, { forwardSecrecy: bob }), { secret: "gen1" });

    // but the OLD ciphertext is now undecryptable — a compromise here reveals no past traffic.
    assert.throws(() => decryptWithForwardSecrecy(oldCiphertext, { forwardSecrecy: bob }), DestroyedKeyReferenceError);
  });

  it("a retention window keeps in-flight (previous-generation) messages decryptable", async () => {
    const secret = makeSecret(12);
    const alice = makeManager({ retainedGenerations: 1 }).manager;
    const bob = makeManager({ retainedGenerations: 1 }).manager;
    const a = await start(alice, { rootSecret: secret });
    const b = await start(bob, { rootSecret: secret });

    const inFlight = encryptWithForwardSecrecy({ m: "gen0" }, { sessionId: a.sessionId }, { forwardSecrecy: alice });
    await alice.evolve(a.sessionId);
    await bob.evolve(b.sessionId);
    // gen 0 still in the retain window → the late message decrypts.
    assert.deepEqual(decryptWithForwardSecrecy(inFlight, { forwardSecrecy: bob }), { m: "gen0" });

    // after a second evolution, gen 0 ages out and is destroyed.
    await bob.evolve(b.sessionId);
    assert.throws(() => decryptWithForwardSecrecy(inFlight, { forwardSecrecy: bob }), DestroyedKeyReferenceError);
  });

  it("key provider returns current-generation keys; interceptor round-trips", async () => {
    const ctx = makeManager();
    const s = await start(ctx.manager);
    const provider = createForwardSecrecyKeyProvider(ctx.manager);
    assert.equal(provider(s.sessionId).keyId, s.generations[0].keyId);

    const interceptor = createForwardSecrecyInterceptor({ forwardSecrecy: ctx.manager });
    const outbound = interceptor.encryptOutbound({ sessionId: s.sessionId, payload: { text: "hi" } }, { sessionId: s.sessionId });
    assert.equal(outbound.secured, true);
    assert.ok(outbound.encryption);
    const inbound = interceptor.decryptInbound(outbound, { sessionId: s.sessionId });
    assert.deepEqual(inbound.payload, { text: "hi" });
  });
});
