import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { relayManager } from "../../controllers/secureTransportController.js";
import { toStoredCiphertext } from "../../secure-transport/index.js";

const subtle = crypto.webcrypto.subtle;

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
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
    String(meta.timestamp ?? ""),
    meta.nonce || "",
  ];
  return new TextEncoder().encode(parts.join("|"));
}

async function generateECDHKeyPair() {
  const keyPair = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const rawPub = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
  return {
    publicKey: toBase64(rawPub),
    privateKey: keyPair.privateKey,
  };
}

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
  const infoBytes = new TextEncoder().encode(`E2EE-SHS-v1-session:${id1}:${id2}`);

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

  return {
    encKeyBits: derivedBytes.slice(0, 32),
    macKeyBits: derivedBytes.slice(32, 64),
  };
}

async function deriveGroupSubkeys(groupKeyBytes, groupId) {
  const salt = new TextEncoder().encode(`MERN-Group-Salt-v1:${groupId}`);
  const info = new TextEncoder().encode(`Group-E2EE-Subkeys-v1:${groupId}`);

  const hkdfKey = await subtle.importKey("raw", groupKeyBytes, "HKDF", false, ["deriveBits"]);
  const derivedBytes = new Uint8Array(
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      hkdfKey,
      64 * 8
    )
  );

  return {
    encKeyBytes: derivedBytes.slice(0, 32),
    macKeyBytes: derivedBytes.slice(32, 64),
  };
}

describe("Milestone 3 — Group Chat End-to-End Encryption (Sender Keys)", () => {
  it("distributes group symmetric keys to members via pairwise E2EE fan-out", async () => {
    // 1. Members Alice (Admin), Bob, and Charlie generate ECDH keypairs
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const charlie = await generateECDHKeyPair();

    // 2. Alice generates a 32-byte group key
    const rawGroupKey = crypto.webcrypto.getRandomValues(new Uint8Array(32));

    // 3. Alice encrypts the group key for Bob and Charlie using pairwise ECDH sessions
    const aliceBobSession = await derivePairwiseKeys(alice.privateKey, bob.publicKey, "alice-id", "bob-id");
    const aliceCharlieSession = await derivePairwiseKeys(alice.privateKey, charlie.publicKey, "alice-id", "charlie-id");

    // Encrypt for Bob
    const bobAesKey = await subtle.importKey("raw", aliceBobSession.encKeyBits, "AES-GCM", false, ["encrypt"]);
    const bobIv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const bobEncBuf = await subtle.encrypt({ name: "AES-GCM", iv: bobIv, tagLength: 128 }, bobAesKey, rawGroupKey);
    const bobEncBytes = new Uint8Array(bobEncBuf);
    const bobRecord = {
      userId: "bob-id",
      encryptedKey: toBase64(bobEncBytes.slice(0, bobEncBytes.length - 16)),
      tag: toBase64(bobEncBytes.slice(bobEncBytes.length - 16)),
      iv: toBase64(bobIv),
      senderId: "alice-id",
      epoch: 1,
    };

    // Encrypt for Charlie
    const charlieAesKey = await subtle.importKey("raw", aliceCharlieSession.encKeyBits, "AES-GCM", false, ["encrypt"]);
    const charlieIv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const charlieEncBuf = await subtle.encrypt({ name: "AES-GCM", iv: charlieIv, tagLength: 128 }, charlieAesKey, rawGroupKey);
    const charlieEncBytes = new Uint8Array(charlieEncBuf);
    const charlieRecord = {
      userId: "charlie-id",
      encryptedKey: toBase64(charlieEncBytes.slice(0, charlieEncBytes.length - 16)),
      tag: toBase64(charlieEncBytes.slice(charlieEncBytes.length - 16)),
      iv: toBase64(charlieIv),
      senderId: "alice-id",
      epoch: 1,
    };

    // 4. Bob receives his record and decrypts the group key
    const bobAliceSession = await derivePairwiseKeys(bob.privateKey, alice.publicKey, "bob-id", "alice-id");
    const bobDecryptKey = await subtle.importKey("raw", bobAliceSession.encKeyBits, "AES-GCM", false, ["decrypt"]);
    const bobCombined = Buffer.concat([Buffer.from(fromBase64(bobRecord.encryptedKey)), Buffer.from(fromBase64(bobRecord.tag))]);
    const bobDecryptedKey = new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: fromBase64(bobRecord.iv), tagLength: 128 }, bobDecryptKey, bobCombined)
    );

    // 5. Charlie receives his record and decrypts the group key
    const charlieAliceSession = await derivePairwiseKeys(charlie.privateKey, alice.publicKey, "charlie-id", "alice-id");
    const charlieDecryptKey = await subtle.importKey("raw", charlieAliceSession.encKeyBits, "AES-GCM", false, ["decrypt"]);
    const charlieCombined = Buffer.concat([Buffer.from(fromBase64(charlieRecord.encryptedKey)), Buffer.from(fromBase64(charlieRecord.tag))]);
    const charlieDecryptedKey = new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: fromBase64(charlieRecord.iv), tagLength: 128 }, charlieDecryptKey, charlieCombined)
    );

    // Both recover the exact same 32-byte group key!
    assert.deepEqual(bobDecryptedKey, rawGroupKey, "Bob must recover authentic group key");
    assert.deepEqual(charlieDecryptedKey, rawGroupKey, "Charlie must recover authentic group key");
  });

  it("completes full Group E2EE flow: Alice encrypts -> Server Relays without keys -> Bob and Charlie decrypt", async () => {
    const groupId = "grp_cybersecurity_team";
    const groupKeyBytes = crypto.webcrypto.getRandomValues(new Uint8Array(32));

    const { encKeyBytes, macKeyBytes } = await deriveGroupSubkeys(groupKeyBytes, groupId);

    // Alice creates group message
    const plaintextMessage = { text: "Mission status: Milestone 3 Group E2EE active!", timestamp: Date.now() };
    const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const nonce = toBase64(crypto.webcrypto.getRandomValues(new Uint8Array(16)));

    const meta = {
      v: 1,
      payloadVersion: 1,
      type: "message",
      protocolVersion: "1.0",
      sessionId: `grp_${groupId}_ep1`,
      keyId: `grpkey_${groupId}`,
      senderDevice: "alice_client",
      receiverDevice: "",
      timestamp: Date.now(),
      nonce,
    };
    const aad = buildCanonicalAAD(meta);

    const aesKey = await subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["encrypt"]);
    const encryptedBuf = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      new TextEncoder().encode(JSON.stringify(plaintextMessage))
    );
    const encryptedBytes = new Uint8Array(encryptedBuf);
    const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
    const tag = encryptedBytes.slice(encryptedBytes.length - 16);

    const hmacKey = await subtle.importKey("raw", macKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hmacInput = Buffer.concat([Buffer.from(aad), Buffer.from(iv), Buffer.from(ciphertext), Buffer.from(tag)]);
    const mac = new Uint8Array(await subtle.sign("HMAC", hmacKey, hmacInput));

    const securePayload = {
      ...meta,
      encryption: {
        algorithm: "aes-256-gcm",
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        tag: toBase64(tag),
      },
      integrity: {
        algorithm: "hmac-sha256",
        mac: toBase64(mac),
      },
      ratchet: null,
    };

    // Server relays group message (Server holds no group keys)
    const relayResult = relayManager.relay(securePayload, { sessionId: securePayload.sessionId });
    assert.ok(relayResult.payload);
    const stored = toStoredCiphertext(securePayload);
    assert.equal(stored.text, undefined, "Server must NOT store group message plaintext");
    assert.equal(stored.secure.encrypted, true);

    // Bob decrypts message using his group key
    const bobAad = buildCanonicalAAD({
      v: stored.secure.v,
      payloadVersion: stored.secure.payloadVersion,
      type: stored.secure.type,
      protocolVersion: stored.secure.protocolVersion,
      sessionId: stored.secure.sessionId,
      keyId: stored.secure.keyId,
      senderDevice: stored.secure.senderDevice,
      receiverDevice: stored.secure.receiverDevice,
      timestamp: stored.secure.timestamp,
      nonce: stored.secure.nonce,
    });

    const bobSubkeys = await deriveGroupSubkeys(groupKeyBytes, groupId);
    const bobHmacKey = await subtle.importKey("raw", bobSubkeys.macKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bobHmacInput = Buffer.concat([
      Buffer.from(bobAad),
      Buffer.from(fromBase64(stored.secure.iv)),
      Buffer.from(fromBase64(stored.secure.ciphertext)),
      Buffer.from(fromBase64(stored.secure.tag)),
    ]);
    const bobMac = new Uint8Array(await subtle.sign("HMAC", bobHmacKey, bobHmacInput));
    assert.equal(toBase64(bobMac), stored.secure.mac, "HMAC must verify authenticity");

    const bobAesKey = await subtle.importKey("raw", bobSubkeys.encKeyBytes, "AES-GCM", false, ["decrypt"]);
    const bobCombined = Buffer.concat([
      Buffer.from(fromBase64(stored.secure.ciphertext)),
      Buffer.from(fromBase64(stored.secure.tag)),
    ]);
    const decryptedBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(stored.secure.iv), additionalData: bobAad, tagLength: 128 },
      bobAesKey,
      bobCombined
    );

    const decrypted = JSON.parse(new TextDecoder().decode(decryptedBuf));
    assert.equal(decrypted.text, "Mission status: Milestone 3 Group E2EE active!");
  });

  it("detects and rejects tampered group ciphertext", async () => {
    const groupId = "grp_test";
    const groupKeyBytes = crypto.webcrypto.getRandomValues(new Uint8Array(32));
    const { encKeyBytes, macKeyBytes } = await deriveGroupSubkeys(groupKeyBytes, groupId);

    const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const meta = {
      v: 1,
      payloadVersion: 1,
      type: "message",
      protocolVersion: "1.0",
      sessionId: `grp_${groupId}_ep1`,
      keyId: `grpkey_${groupId}`,
      senderDevice: "alice",
      receiverDevice: "",
      timestamp: Date.now(),
      nonce: toBase64(crypto.webcrypto.getRandomValues(new Uint8Array(16))),
    };
    const aad = buildCanonicalAAD(meta);

    const aesKey = await subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["encrypt"]);
    const encryptedBuf = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      new TextEncoder().encode(JSON.stringify({ text: "Tamper test" }))
    );
    const encryptedBytes = new Uint8Array(encryptedBuf);
    const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
    const tag = encryptedBytes.slice(encryptedBytes.length - 16);

    // Tamper with ciphertext byte
    ciphertext[0] ^= 0xaa;

    const hmacKey = await subtle.importKey("raw", macKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hmacInput = Buffer.concat([Buffer.from(aad), Buffer.from(iv), Buffer.from(ciphertext), Buffer.from(tag)]);
    const recalculatedMac = new Uint8Array(await subtle.sign("HMAC", hmacKey, hmacInput));

    const bobAesKey = await subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["decrypt"]);
    const tamperedCombined = Buffer.concat([Buffer.from(ciphertext), Buffer.from(tag)]);

    await assert.rejects(
      async () => {
        await subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          bobAesKey,
          tamperedCombined
        );
      },
      { name: "OperationError" },
      "Tampered group message must fail AEAD tag check"
    );
  });
});
