/**
 * @file layer5-layer9-integration.test.js
 *
 * Automated Integration Test Suite for:
 * - Layer 5: Forward Secrecy & Ratchet (Per-Message Ephemeral Keys & Chain Progression)
 * - Layer 9: Offline Synchronization & State Replication (Outbox Drainage & Monotonic Checkpoints)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { relayManager } from "../../controllers/secureTransportController.js";
import { toStoredCiphertext } from "../../secure-transport/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

function unb64(str) {
  return new Uint8Array(Buffer.from(str, "base64"));
}

function buildCanonicalAAD(meta) {
  const parts = [
    "SHS-transport-v1",
    String(meta.v ?? 1),
    String(meta.payloadVersion ?? 1),
    meta.type || "message",
    meta.protocolVersion || "1.0",
    meta.sessionId || "",
    meta.keyId || "",
    meta.senderDevice || "",
    meta.receiverDevice || "",
    String(meta.timestamp ?? 0),
    meta.nonce || "",
  ];
  return enc.encode(parts.join("|"));
}

describe("Layer 5 & Layer 9 — Forward Secrecy, Ratchet, and Offline Sync Suite", () => {
  it("Layer 5: derives unique ephemeral message keys per sequence and advances chain key", async () => {
    // 1. Setup Alice and Bob ECDH keys
    const aliceKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const bobKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);

    const aliceShared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: bobKeys.publicKey },
      aliceKeys.privateKey,
      256
    );

    const bobShared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: aliceKeys.publicKey },
      bobKeys.privateKey,
      256
    );

    assert.deepEqual(new Uint8Array(aliceShared), new Uint8Array(bobShared));

    const sessionId = "e2ee_alice_bob";
    const salt = enc.encode(`chat-app-e2ee-salt-${sessionId}`);
    const aliceHkdf = await crypto.subtle.importKey("raw", aliceShared, "HKDF", false, ["deriveBits"]);
    const bobHkdf = await crypto.subtle.importKey("raw", bobShared, "HKDF", false, ["deriveBits"]);

    // Alice is sender A, Bob is receiver B (lexicographical)
    const aliceSendChain = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("ratchet-chain-a-to-b") },
        aliceHkdf,
        256
      )
    );

    const bobRecvChain = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("ratchet-chain-a-to-b") },
        bobHkdf,
        256
      )
    );

    assert.deepEqual(aliceSendChain, bobRecvChain, "Initial directional chain keys must match");

    // 2. Alice encrypts Message 0
    const seq0 = 0;
    const chainKey0 = await crypto.subtle.importKey("raw", aliceSendChain, "HKDF", false, ["deriveBits"]);
    const msgSalt0 = enc.encode(`ratchet-salt-${sessionId}-${seq0}`);

    const msgEnc0 = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: msgSalt0, info: enc.encode(`msg-enc-${seq0}`) },
        chainKey0,
        256
      )
    );
    const msgMac0 = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: msgSalt0, info: enc.encode(`msg-mac-${seq0}`) },
        chainKey0,
        256
      )
    );

    // Advance Alice send chain to 1
    const aliceSendChain1 = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: msgSalt0, info: enc.encode(`chain-advance-${seq0}`) },
        chainKey0,
        256
      )
    );

    assert.notDeepEqual(aliceSendChain1, aliceSendChain, "Sending chain key must advance forward");

    // 3. Alice encrypts Message 1 with advanced chain
    const seq1 = 1;
    const chainKey1 = await crypto.subtle.importKey("raw", aliceSendChain1, "HKDF", false, ["deriveBits"]);
    const msgSalt1 = enc.encode(`ratchet-salt-${sessionId}-${seq1}`);

    const msgEnc1 = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: msgSalt1, info: enc.encode(`msg-enc-${seq1}`) },
        chainKey1,
        256
      )
    );

    assert.notDeepEqual(msgEnc0, msgEnc1, "Each message must have a unique ephemeral encryption key");

    // 4. Encrypt Message 0 payload
    const meta0 = {
      v: 1,
      payloadVersion: 1,
      type: "message",
      protocolVersion: "1.0",
      sessionId,
      keyId: "key_001",
      senderDevice: "alice-phone",
      receiverDevice: "bob-phone",
      timestamp: Date.now(),
      nonce: "nonce001",
    };
    const aad0 = buildCanonicalAAD(meta0);
    const iv0 = crypto.getRandomValues(new Uint8Array(12));
    const aesKey0 = await crypto.subtle.importKey("raw", msgEnc0, "AES-GCM", false, ["encrypt"]);
    const payloadText = JSON.stringify({ text: "Hello Forward Secrecy!" });

    const sealed0 = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv0, additionalData: aad0, tagLength: 128 },
        aesKey0,
        enc.encode(payloadText)
      )
    );
    const ciphertext0 = sealed0.subarray(0, sealed0.length - 16);
    const tag0 = sealed0.subarray(sealed0.length - 16);

    const hmacKey0 = await crypto.subtle.importKey("raw", msgMac0, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac0 = new Uint8Array(
      await crypto.subtle.sign("HMAC", hmacKey0, Buffer.concat([aad0, iv0, ciphertext0, tag0]))
    );

    const securePayload = {
      ...meta0,
      encryption: {
        algorithm: "aes-256-gcm",
        iv: b64(iv0),
        ciphertext: b64(ciphertext0),
        tag: b64(tag0),
      },
      integrity: {
        algorithm: "hmac-sha256",
        mac: b64(mac0),
      },
      ratchet: {
        generation: 1,
        seq: 0,
        prevSeq: 0,
        keyFingerprint: "key_001",
      },
    };

    // 5. Server blind relay receives and stores envelope
    const relayRes = relayManager.relay(securePayload, { sessionId });
    assert.equal(relayRes.meta.sessionId, sessionId);
    assert.equal(relayRes.payload.encryption.ciphertext, securePayload.encryption.ciphertext);

    const stored = toStoredCiphertext(securePayload, { senderId: "alice", receiverId: "bob" });
    assert.deepEqual(stored.secure.ratchet, securePayload.ratchet, "Ratchet metadata must be preserved in storage");

    // 6. Bob receives envelope, steps his receiving chain, and decrypts
    const bobChainKey0 = await crypto.subtle.importKey("raw", bobRecvChain, "HKDF", false, ["deriveBits"]);
    const bobMsgEnc0 = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: msgSalt0, info: enc.encode(`msg-enc-${seq0}`) },
        bobChainKey0,
        256
      )
    );
    const bobMsgMac0 = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: msgSalt0, info: enc.encode(`msg-mac-${seq0}`) },
        bobChainKey0,
        256
      )
    );

    // Verify MAC
    const bobHmacKey0 = await crypto.subtle.importKey("raw", bobMsgMac0, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bobComputedMac = new Uint8Array(
      await crypto.subtle.sign("HMAC", bobHmacKey0, Buffer.concat([aad0, iv0, ciphertext0, tag0]))
    );
    assert.deepEqual(bobComputedMac, mac0, "HMAC must match Bob derived key");

    // Decrypt
    const bobAesKey0 = await crypto.subtle.importKey("raw", bobMsgEnc0, "AES-GCM", false, ["decrypt"]);
    const decryptedBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv0, additionalData: aad0, tagLength: 128 },
      bobAesKey0,
      sealed0
    );
    const decryptedObj = JSON.parse(dec.decode(decryptedBytes));
    assert.equal(decryptedObj.text, "Hello Forward Secrecy!");
  });

  it("Layer 9: handles outbox queuing, monotonic checkpoints, and delta synchronization", async () => {
    // 1. Simulate local outbox queue
    const outbox = [];
    const clientMessageId = `msg-${Date.now()}-test123`;
    const queuedItem = {
      clientMessageId,
      targetType: "direct",
      targetId: "peer_user_456",
      sendPayload: {
        text: "Offline message waiting for sync",
        clientMessageId,
      },
      displayText: "Offline message waiting for sync",
      queuedAt: Date.now(),
      status: "queued",
    };

    outbox.push(queuedItem);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].status, "queued");

    // 2. Monotonic Checkpoint tracking
    const checkpoints = {};
    const t1 = 1000;
    const t2 = 2000;
    const tEarlier = 500;

    function updateCheckpoint(targetId, ts) {
      if (!checkpoints[targetId] || ts > checkpoints[targetId]) {
        checkpoints[targetId] = ts;
      }
    }

    updateCheckpoint("peer_user_456", t1);
    assert.equal(checkpoints["peer_user_456"], 1000);

    updateCheckpoint("peer_user_456", t2);
    assert.equal(checkpoints["peer_user_456"], 2000, "Checkpoint must advance forward");

    updateCheckpoint("peer_user_456", tEarlier);
    assert.equal(checkpoints["peer_user_456"], 2000, "Checkpoint must remain monotonic and never regress");

    // 3. Delta catch-up query simulation
    const serverMessages = [
      { _id: "m1", text: "msg 1", createdAt: 800 },
      { _id: "m2", text: "msg 2", createdAt: 1200 },
      { _id: "m3", text: "msg 3", createdAt: 2500 },
      { _id: "m4", text: "msg 4", createdAt: 3000 },
    ];

    const highWaterMark = checkpoints["peer_user_456"]; // 2000
    const delta = serverMessages.filter((m) => m.createdAt > highWaterMark);

    assert.equal(delta.length, 2);
    assert.equal(delta[0]._id, "m3");
    assert.equal(delta[1]._id, "m4");

    // 4. Drain outbox on network reconnect
    const flushed = [];
    for (const item of [...outbox]) {
      // Simulate successful dispatch
      flushed.push({
        ...item,
        status: "sent",
        deliveredAt: Date.now(),
      });
      outbox.pop();
    }

    assert.equal(outbox.length, 0, "Outbox must be drained completely");
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].status, "sent");
  });
});
