import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SecureTransportManager, TransportMetric } from "../manager/secureTransportManager.js";
import { InMemoryTransport } from "../transport/transport.js";
import { createRestTransport, createSocketTransport } from "../adapters/transportAdapters.js";
import {
  toStoredCiphertext,
  fromStoredCiphertext,
  createInMemoryCiphertextRepository,
} from "../repositories/ciphertextRepository.js";
import { createSecureTransportMiddleware } from "../middleware/secureTransportMiddleware.js";
import { SecureTransportEventType } from "../events/events.js";
import { encryptMessage } from "../encryptor/encryptor.js";
import { decryptMessage } from "../decryptor/decryptor.js";
import { SessionKeyError, MalformedPayloadError } from "../errors.js";
import { sessionKeys, deviceManager, relay, captureEvents } from "./helpers.js";

const ctx = { sessionId: "s1", senderDevice: "devA", receiverDevice: "devB" };

describe("SecureTransportManager", () => {
  it("encrypt + decrypt with metrics + events", async () => {
    const k = sessionKeys();
    const mgr = deviceManager(k);
    const { seen } = captureEvents(mgr.events);
    const { serialized } = await mgr.encrypt({ text: "hi" }, ctx);
    assert.equal(typeof serialized, "string");
    assert.deepEqual(await mgr.decrypt(serialized), { text: "hi" });
    const snap = mgr.metricsSnapshot();
    assert.equal(snap.counters[TransportMetric.ENCRYPTED], 1);
    assert.equal(snap.counters[TransportMetric.DECRYPTED], 1);
    assert.ok(snap.histograms[TransportMetric.CIPHERTEXT_BYTES].count === 1);
    assert.ok(seen.some((e) => e.type === SecureTransportEventType.MESSAGE_ENCRYPTED));
    assert.ok(seen.some((e) => e.type === SecureTransportEventType.MESSAGE_DECRYPTED));
  });

  it("relay manager (no keys) cannot encrypt or decrypt", async () => {
    const server = relay();
    await assert.rejects(() => server.encrypt({ text: "x" }, ctx), SessionKeyError);
    const { serialized } = await deviceManager(sessionKeys()).encrypt({ text: "x" }, ctx);
    await assert.rejects(() => server.decrypt(serialized), SessionKeyError);
  });

  it("encryptAndSend over the transport abstraction (send → subscribe → decrypt)", async () => {
    const k = sessionKeys();
    const alice = deviceManager(k);
    const bob = deviceManager(k);
    const tx = new InMemoryTransport();
    let received = null;
    tx.subscribe(async (s) => (received = await bob.decrypt(s)));
    await alice.encryptAndSend({ text: "over transport" }, ctx, tx);
    assert.deepEqual(received, { text: "over transport" });
  });

  it("REST + WebSocket adapters share the transport interface", async () => {
    const posted = [];
    const rest = createRestTransport({ post: (s) => posted.push(s) });
    assert.equal(rest.name, "rest");
    await rest.send("payload");
    assert.equal(posted.length, 1);

    const emitted = [];
    const ws = createSocketTransport({ emit: (s) => emitted.push(s) });
    assert.equal(ws.name, "websocket");
    await ws.send("payload");
    assert.equal(emitted.length, 1);
  });
});

describe("relay + ciphertext repository (server stores ciphertext only)", () => {
  it("validateForRelay accepts ciphertext, rejects plaintext + mismatched binding", () => {
    const server = relay();
    const payload = encryptMessage({ text: "hi" }, sessionKeys(), ctx);
    assert.doesNotThrow(() => server.relay(payload, { sessionId: "s1" }));
    assert.throws(() => server.relay({ text: "plaintext" }), MalformedPayloadError);
    assert.throws(() => server.relay(payload, { sessionId: "other" }), /mismatch/i);
  });

  it("stored record has NO plaintext / keys; reconstruct → decrypt", () => {
    const k = sessionKeys();
    const payload = encryptMessage({ text: "persist me" }, k, ctx);
    const stored = toStoredCiphertext(payload, { senderId: "a", receiverId: "b" });
    assert.equal(stored.secure.encrypted, true);
    const json = JSON.stringify(stored);
    assert.equal(json.includes("persist me"), false);
    assert.equal(json.includes(k.encryptionKey.toString("base64")), false);
    // reconstruct + decrypt (the delivery path)
    const rebuilt = fromStoredCiphertext(stored);
    assert.deepEqual(decryptMessage(rebuilt, k), { text: "persist me" });
  });

  it("in-memory ciphertext repository stores + lists between users", async () => {
    const repo = createInMemoryCiphertextRepository();
    const payload = encryptMessage({ text: "x" }, sessionKeys(), ctx);
    await repo.messages.create(toStoredCiphertext(payload, { senderId: "a", receiverId: "b" }));
    const between = await repo.messages.listBetween("a", "b");
    assert.equal(between.length, 1);
    assert.equal(between[0].secure.encrypted, true);
  });
});

describe("relay middleware", () => {
  function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    return res;
  }

  it("validateSecurePayload attaches valid ciphertext; passes through plaintext", () => {
    const { validateSecurePayload } = createSecureTransportMiddleware();
    const payload = encryptMessage({ text: "hi" }, sessionKeys(), ctx);
    const req1 = { body: { securePayload: payload, sessionId: "s1" } };
    let nexted = false;
    validateSecurePayload(req1, fakeRes(), () => (nexted = true));
    assert.equal(nexted, true);
    assert.ok(req1.secureTransport);

    const req2 = { body: { text: "plaintext" } };
    let nexted2 = false;
    validateSecurePayload(req2, fakeRes(), () => (nexted2 = true));
    assert.equal(nexted2, true); // plaintext passes through (fallback)
  });

  it("requireCiphertext rejects plaintext when E2E is enforced", () => {
    const { requireCiphertext } = createSecureTransportMiddleware({ enforceE2E: true });
    const res = fakeRes();
    requireCiphertext({ body: { text: "plaintext" } }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "ERR_TRANSPORT_MALFORMED");
  });
});
