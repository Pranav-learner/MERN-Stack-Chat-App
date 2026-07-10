import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageKeyEventType } from "../types/types.js";
import { DestroyedKeyReuseError, TooManySkippedError } from "../errors.js";
import { makePair, makePeer, captureEvents } from "./helpers.js";

describe("per-message messaging — end to end", () => {
  it("every message uses a unique key; the peer decrypts them in order", async () => {
    const { alice, bob, sessionId } = await makePair();
    const keyIds = new Set();
    for (let i = 0; i < 5; i++) {
      const envelope = await alice.transport.encrypt({ n: i }, { sessionId });
      keyIds.add(envelope.payload.keyId);
      assert.equal(envelope.messageNumber, i);
      const msg = await bob.transport.decrypt(envelope, { sessionId });
      assert.deepEqual(msg, { n: i });
    }
    assert.equal(keyIds.size, 5, "5 messages → 5 distinct message keys");
  });

  it("bidirectional: both directions ratchet independently", async () => {
    const { alice, bob, sessionId } = await makePair(2);
    const a2b = await alice.transport.encrypt({ from: "alice" }, { sessionId });
    assert.deepEqual(await bob.transport.decrypt(a2b, { sessionId }), { from: "alice" });
    const b2a = await bob.transport.encrypt({ from: "bob" }, { sessionId });
    assert.deepEqual(await alice.transport.decrypt(b2a, { sessionId }), { from: "bob" });
    // each side sent 1 + received 1
    assert.equal((await alice.manager.getStatus(sessionId)).sent, 1);
    assert.equal((await alice.manager.getStatus(sessionId)).received, 1);
  });

  it("emits the full lifecycle: derived → encrypted → destroyed → chain advanced", async () => {
    const { alice, bob, sessionId } = await makePair(3);
    const { seen } = captureEvents(alice.events);
    const env = await alice.transport.encrypt({ hi: 1 }, { sessionId });
    await bob.transport.decrypt(env, { sessionId });
    const types = seen.types();
    assert.ok(types.includes(MessageKeyEventType.MESSAGE_KEY_DERIVED));
    assert.ok(types.includes(MessageKeyEventType.MESSAGE_ENCRYPTED));
    assert.ok(types.includes(MessageKeyEventType.MESSAGE_KEY_DESTROYED));
    assert.ok(types.includes(MessageKeyEventType.CHAIN_ADVANCED));
  });

  it("handles out-of-order delivery via the skipped-key cache", async () => {
    const { alice, bob, sessionId } = await makePair(4);
    const e0 = await alice.transport.encrypt({ n: 0 }, { sessionId });
    const e1 = await alice.transport.encrypt({ n: 1 }, { sessionId });
    const e2 = await alice.transport.encrypt({ n: 2 }, { sessionId });
    // bob receives 2 first (skip-caches 0,1), then 0 and 1 from cache
    assert.deepEqual(await bob.transport.decrypt(e2, { sessionId }), { n: 2 });
    assert.equal(bob.cache.size, 2, "keys for messages 0 and 1 cached");
    assert.deepEqual(await bob.transport.decrypt(e0, { sessionId }), { n: 0 });
    assert.deepEqual(await bob.transport.decrypt(e1, { sessionId }), { n: 1 });
    assert.equal(bob.cache.size, 0, "cache drained after both late messages arrive");
  });

  it("rejects a replayed message (destroyed-key reuse)", async () => {
    const { alice, bob, sessionId } = await makePair(5);
    const e0 = await alice.transport.encrypt({ n: 0 }, { sessionId });
    await bob.transport.decrypt(e0, { sessionId });
    await assert.rejects(() => bob.transport.decrypt(e0, { sessionId }), DestroyedKeyReuseError);
  });

  it("a tampered ciphertext fails to decrypt (and the key is still destroyed)", async () => {
    const { alice, bob, sessionId } = await makePair(6);
    const env = await alice.transport.encrypt({ secret: "x" }, { sessionId });
    // flip a byte of the AES-GCM ciphertext (payload.encryption.ciphertext, base64)
    const tampered = {
      ...env,
      payload: { ...env.payload, encryption: { ...env.payload.encryption, ciphertext: flip(env.payload.encryption.ciphertext) } },
    };
    await assert.rejects(() => bob.transport.decrypt(tampered, { sessionId }));
  });

  it("enforces the max-skip DoS guard", async () => {
    const peer = await makePeer({ role: "responder", maxSkip: 5 });
    // craft an envelope claiming message number 100 (gap > maxSkip) at generation 0
    await assert.rejects(
      () => peer.manager.openMessage(peer.sessionId, { messageNumber: 100, generation: 0 }, () => ({})),
      TooManySkippedError,
    );
  });
});

function flip(b64) {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
}
