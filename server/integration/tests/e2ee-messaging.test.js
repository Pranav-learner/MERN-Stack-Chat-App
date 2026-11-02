import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { relayManager } from "../../controllers/secureTransportController.js";
import { toStoredCiphertext } from "../../secure-transport/index.js";

const subtle = crypto.webcrypto.subtle;

// Helper: Convert Uint8Array to base64
function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

// Helper: Convert base64 to Uint8Array
function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// Canonical AAD builder matching server/secure-transport/metadata/metadata.js
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
    String(meta.timestamp ?? ""),
    meta.nonce || "",
  ];
  return new TextEncoder().encode(parts.join("|"));
}

// Generate P-256 keypair
async function generateECDHKeyPair() {
  const keyPair = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const rawPub = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
  return {
    publicKey: toBase64(rawPub),
    rawPub,
    privateKey: keyPair.privateKey,
  };
}

// Derive pairwise keys matching client e2eeService.js
async function derivePairwiseKeys(myPrivKey, peerPubB64, userAId, userBId) {
  const peerPubRaw = fromBase64(peerPubB64);
  const peerPubKey = await subtle.importKey(
    "raw",
    peerPubRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const sharedBits = await subtle.deriveBits(
    { name: "ECDH", public: peerPubKey },
    myPrivKey,
    256
  );

  const [id1, id2] = [String(userAId), String(userBId)].sort();
  const infoString = `E2EE-SHS-v1-session:${id1}:${id2}`;
  const infoBytes = new TextEncoder().encode(infoString);

  const hkdfKey = await subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const derivedBytes = new Uint8Array(
    await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("MERN-Chat-Salt-v1"),
        info: infoBytes,
      },
      hkdfKey,
      64 * 8
    )
  );

  const encKeyBits = derivedBytes.slice(0, 32);
  const macKeyBits = derivedBytes.slice(32, 64);

  const idHash = crypto.createHash("sha256").update(derivedBytes).digest("hex");
  const sessionId = `sess_${idHash.slice(0, 16)}`;
  const keyId = `key_${idHash.slice(16, 28)}`;

  return { encKeyBits, macKeyBits, sessionId, keyId };
}

describe("Milestone 1 — E2EE 1-on-1 Messaging Integration Suite", () => {
  it("derives identical symmetric keys symmetrically between Alice and Bob", async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();

    const aliceSession = await derivePairwiseKeys(alice.privateKey, bob.publicKey, "alice123", "bob456");
    const bobSession = await derivePairwiseKeys(bob.privateKey, alice.publicKey, "bob456", "alice123");

    assert.equal(aliceSession.sessionId, bobSession.sessionId, "Session IDs must match");
    assert.equal(aliceSession.keyId, bobSession.keyId, "Key IDs must match");
    assert.deepEqual(aliceSession.encKeyBits, bobSession.encKeyBits, "Encryption keys must match");
    assert.deepEqual(aliceSession.macKeyBits, bobSession.macKeyBits, "MAC keys must match");
  });

  it("completes full E2EE flow: Alice encrypts -> Server Relays without keys -> Bob decrypts", async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();

    const aliceSession = await derivePairwiseKeys(alice.privateKey, bob.publicKey, "alice123", "bob456");
    const bobSession = await derivePairwiseKeys(bob.privateKey, alice.publicKey, "bob456", "alice123");

    // 1. Alice creates message payload and encrypts
    const plaintextMessage = { text: "Secret milestone 1 direct message!", timestamp: Date.now() };
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintextMessage));

    const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const nonce = crypto.webcrypto.getRandomValues(new Uint8Array(16));
    const nonceB64 = toBase64(nonce);

    const meta = {
      v: 1,
      payloadVersion: 1,
      type: "message",
      protocolVersion: "1.0",
      sessionId: aliceSession.sessionId,
      keyId: aliceSession.keyId,
      senderDevice: "alice_web_1",
      receiverDevice: "bob_web_1",
      timestamp: Date.now(),
      nonce: nonceB64,
    };

    const aad = buildCanonicalAAD(meta);

    // Encrypt AES-256-GCM
    const aesKey = await subtle.importKey("raw", aliceSession.encKeyBits, "AES-GCM", false, ["encrypt"]);
    const encryptedBuf = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      plaintextBytes
    );

    const encryptedBytes = new Uint8Array(encryptedBuf);
    const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
    const tag = encryptedBytes.slice(encryptedBytes.length - 16);

    // Compute HMAC-SHA256
    const hmacKey = await subtle.importKey(
      "raw",
      aliceSession.macKeyBits,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const hmacInput = Buffer.concat([Buffer.from(aad), Buffer.from(iv), Buffer.from(ciphertext), Buffer.from(tag)]);
    const macBytes = new Uint8Array(await subtle.sign("HMAC", hmacKey, hmacInput));

    const securePayload = {
      v: 1,
      payloadVersion: 1,
      type: "message",
      protocolVersion: "1.0",
      sessionId: aliceSession.sessionId,
      keyId: aliceSession.keyId,
      senderDevice: "alice_web_1",
      receiverDevice: "bob_web_1",
      timestamp: meta.timestamp,
      nonce: nonceB64,
      encryption: {
        algorithm: "aes-256-gcm",
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        tag: toBase64(tag),
      },
      integrity: {
        algorithm: "hmac-sha256",
        mac: toBase64(macBytes),
      },
      ratchet: null,
    };

    // 2. Server relays payload (Server has NO keys)
    assert.equal(relayManager.keyProvider, null, "Relay manager must have zero access to session keys");
    const relayResult = relayManager.relay(securePayload, { sessionId: aliceSession.sessionId });
    assert.ok(relayResult.payload, "Relay must validate payload structure and envelope");
    assert.equal(relayResult.payload.sessionId, aliceSession.sessionId);

    // 3. Server generates stored ciphertext document for MongoDB
    const storedDoc = toStoredCiphertext(securePayload);
    assert.equal(storedDoc.secure.encrypted, true);
    assert.equal(storedDoc.secure.ciphertext, securePayload.encryption.ciphertext);
    assert.equal(storedDoc.secure.mac, securePayload.integrity.mac);

    // Verify zero plaintext stored
    assert.equal(storedDoc.text, undefined, "Plaintext text must NOT exist in stored document");
    assert.equal(storedDoc.image, undefined, "Plaintext image must NOT exist in stored document");

    // 4. Bob receives stored document and decrypts
    const s = storedDoc.secure;
    const bobAad = buildCanonicalAAD({
      v: s.v,
      payloadVersion: s.payloadVersion,
      type: s.type,
      protocolVersion: s.protocolVersion,
      sessionId: s.sessionId,
      keyId: s.keyId,
      senderDevice: s.senderDevice,
      receiverDevice: s.receiverDevice,
      timestamp: s.timestamp,
      nonce: s.nonce,
    });

    const bobHmacKey = await subtle.importKey(
      "raw",
      bobSession.macKeyBits,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const bobHmacInput = Buffer.concat([
      Buffer.from(bobAad),
      Buffer.from(fromBase64(s.iv)),
      Buffer.from(fromBase64(s.ciphertext)),
      Buffer.from(fromBase64(s.tag)),
    ]);
    const bobExpectedMac = new Uint8Array(await subtle.sign("HMAC", bobHmacKey, bobHmacInput));

    assert.equal(
      toBase64(bobExpectedMac),
      s.mac,
      "HMAC tag must match authentic sender's tag"
    );

    // Bob decrypts AES-GCM
    const bobAesKey = await subtle.importKey("raw", bobSession.encKeyBits, "AES-GCM", false, ["decrypt"]);
    const bobCombined = Buffer.concat([
      Buffer.from(fromBase64(s.ciphertext)),
      Buffer.from(fromBase64(s.tag)),
    ]);
    const decryptedBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(s.iv), additionalData: bobAad, tagLength: 128 },
      bobAesKey,
      bobCombined
    );

    const decrypted = JSON.parse(new TextDecoder().decode(decryptedBuf));
    assert.equal(decrypted.text, "Secret milestone 1 direct message!");
  });

  it("detects and rejects tampered ciphertext or tags (integrity guarantee)", async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const aliceSession = await derivePairwiseKeys(alice.privateKey, bob.publicKey, "alice123", "bob456");
    const bobSession = await derivePairwiseKeys(bob.privateKey, alice.publicKey, "bob456", "alice123");

    const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const nonce = crypto.webcrypto.getRandomValues(new Uint8Array(16));
    const meta = {
      v: 1,
      payloadVersion: 1,
      type: "message",
      protocolVersion: "1.0",
      sessionId: aliceSession.sessionId,
      keyId: aliceSession.keyId,
      senderDevice: "alice_web_1",
      receiverDevice: "bob_web_1",
      timestamp: Date.now(),
      nonce: toBase64(nonce),
    };
    const aad = buildCanonicalAAD(meta);

    const aesKey = await subtle.importKey("raw", aliceSession.encKeyBits, "AES-GCM", false, ["encrypt"]);
    const encryptedBuf = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      new TextEncoder().encode(JSON.stringify({ text: "Tamper test" }))
    );
    const encryptedBytes = new Uint8Array(encryptedBuf);
    const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
    const tag = encryptedBytes.slice(encryptedBytes.length - 16);

    const hmacKey = await subtle.importKey("raw", aliceSession.macKeyBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hmacInput = Buffer.concat([Buffer.from(aad), Buffer.from(iv), Buffer.from(ciphertext), Buffer.from(tag)]);
    const macBytes = new Uint8Array(await subtle.sign("HMAC", hmacKey, hmacInput));

    // Tamper with ciphertext by altering a single byte
    const tamperedCiphertext = new Uint8Array(ciphertext);
    tamperedCiphertext[0] ^= 0xff;

    // Bob checks HMAC on tampered ciphertext
    const bobHmacKey = await subtle.importKey("raw", bobSession.macKeyBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bobHmacInput = Buffer.concat([
      Buffer.from(aad),
      Buffer.from(iv),
      Buffer.from(tamperedCiphertext),
      Buffer.from(tag),
    ]);
    const recalculatedMac = new Uint8Array(await subtle.sign("HMAC", bobHmacKey, bobHmacInput));

    // Must NOT match original MAC
    assert.notEqual(
      toBase64(recalculatedMac),
      toBase64(macBytes),
      "Tampered message must produce mismatched HMAC"
    );

    // If an attacker tries to decrypt with invalid tag, AES-GCM must throw OperationError
    const bobAesKey = await subtle.importKey("raw", bobSession.encKeyBits, "AES-GCM", false, ["decrypt"]);
    const tamperedCombined = Buffer.concat([Buffer.from(tamperedCiphertext), Buffer.from(tag)]);

    await assert.rejects(
      async () => {
        await subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          bobAesKey,
          tamperedCombined
        );
      },
      { name: "OperationError" },
      "Tampered ciphertext must cause AEAD authentication failure"
    );
  });
});
