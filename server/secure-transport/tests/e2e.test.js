/**
 * The headline test: the FIRST fully end-to-end encrypted message — encrypted on
 * device A, relayed as ciphertext through a server that cannot decrypt, decrypted on
 * device B. Plus multi-device, offline delivery, concurrency, and performance.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { toStoredCiphertext, fromStoredCiphertext, createInMemoryCiphertextRepository } from "../repositories/ciphertextRepository.js";
import { sessionKeys, deviceManager, relay } from "./helpers.js";

const ctx = { sessionId: "s1", senderDevice: "devA", receiverDevice: "devB" };

describe("🔐 first end-to-end encrypted message", () => {
  it("Alice → (server relays ciphertext, cannot decrypt) → Bob", async () => {
    // Both devices independently hold the SAME session keys (Sprint 3 derivation).
    const keys = sessionKeys();
    const alice = deviceManager(keys);
    const bob = deviceManager(keys);
    const server = relay(); // no keys

    // 1. Alice encrypts on her device.
    const { serialized } = await alice.encrypt({ text: "the first end-to-end encrypted message 🎉" }, ctx);

    // 2. The server relays: validate + persist CIPHERTEXT ONLY. It cannot decrypt.
    const { payload } = server.relay(serialized, { sessionId: "s1" });
    const stored = toStoredCiphertext(payload, { senderId: "alice", receiverId: "bob" });
    assert.equal(stored.secure.encrypted, true);
    assert.equal(JSON.stringify(stored).includes("first end-to-end"), false, "no plaintext stored");
    await assert.rejects(() => server.decrypt(serialized), /relay|keys/i, "server cannot decrypt");

    // 3. Bob receives the stored ciphertext and decrypts on his device.
    const forDelivery = fromStoredCiphertext(stored);
    const message = await bob.decrypt(forDelivery);
    assert.equal(message.text, "the first end-to-end encrypted message 🎉");
  });

  it("a different session/device cannot read another pair's messages", async () => {
    const aliceBob = sessionKeys(1);
    const eve = sessionKeys(2); // different secret → different keys
    const alice = deviceManager(aliceBob);
    const eveMgr = deviceManager(eve);
    const { serialized } = await alice.encrypt({ text: "private" }, ctx);
    await assert.rejects(() => eveMgr.decrypt(serialized), /integrity/i);
  });
});

describe("offline delivery (store → later deliver)", () => {
  it("ciphertext persists in the relay repo and decrypts when delivered", async () => {
    const keys = sessionKeys();
    const alice = deviceManager(keys);
    const bob = deviceManager(keys);
    const repo = createInMemoryCiphertextRepository();

    // Bob is offline: Alice sends, server stores ciphertext.
    const { serialized } = await alice.encrypt({ text: "you were offline" }, ctx);
    const { payload } = relay().relay(serialized);
    const created = await repo.messages.create(toStoredCiphertext(payload, { senderId: "alice", receiverId: "bob" }));

    // Later, Bob comes online and fetches + decrypts.
    const fetched = await repo.messages.findById(created._id);
    const message = await bob.decrypt(fromStoredCiphertext(fetched));
    assert.equal(message.text, "you were offline");
  });
});

describe("multiple devices + concurrency", () => {
  it("a user with two devices — each session has its own keys", async () => {
    const laptop = sessionKeys(1, "k-laptop");
    const phone = sessionKeys(2, "k-phone");
    const alice = deviceManager(laptop);
    const bobLaptop = deviceManager(laptop);
    const bobPhone = deviceManager(phone);
    const { serialized } = await alice.encrypt({ text: "hi laptop" }, ctx);
    assert.deepEqual(await bobLaptop.decrypt(serialized), { text: "hi laptop" });
    // The phone's session keys don't match — rejected (keyId binding catches it first).
    await assert.rejects(() => bobPhone.decrypt(serialized), /mismatch|integrity/i);
  });

  it("100 concurrent encrypt→relay→decrypt round trips", async () => {
    const keys = sessionKeys();
    const alice = deviceManager(keys);
    const bob = deviceManager(keys);
    const server = relay();
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const { serialized } = await alice.encrypt({ text: `msg-${i}` }, ctx);
        const { payload } = server.relay(serialized);
        return (await bob.decrypt(fromStoredCiphertext(toStoredCiphertext(payload)))).text;
      }),
    );
    assert.equal(new Set(results).size, 100);
    assert.equal(results.includes("msg-0"), true);
  });
});

describe("performance (regression guard)", () => {
  it("encrypts + decrypts at a healthy rate", async () => {
    const keys = sessionKeys();
    const mgr = deviceManager(keys);
    const N = 300;
    const msg = { text: "x".repeat(512) };
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      const { serialized } = await mgr.encrypt(msg, ctx);
      await mgr.decrypt(serialized);
    }
    const opsPerSec = Math.round((N / (performance.now() - start)) * 1000);
    assert.ok(opsPerSec > 100, `enc+dec round trips/sec = ${opsPerSec}`);
  });

  it("ciphertext overhead is bounded", async () => {
    const keys = sessionKeys();
    const mgr = deviceManager(keys);
    const plaintext = JSON.stringify({ text: "hello" });
    const { serialized } = await mgr.encrypt({ text: "hello" }, ctx);
    // metadata + base64 overhead, but no plaintext leak, and reasonable size.
    assert.ok(serialized.length < plaintext.length + 800);
    assert.equal(serialized.includes("hello"), false);
  });
});
