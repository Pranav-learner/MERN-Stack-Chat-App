import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  MediaManager,
  generateMediaKey,
  encryptMedia,
  decryptMedia,
  mediaKeyFingerprint,
  sha256,
  createInMemoryMediaRepository,
  createInMemoryStorageProvider,
} from "../../media/index.js";
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

  const encKeyBits = derivedBytes.slice(0, 32);
  const macKeyBits = derivedBytes.slice(32, 64);
  const idHash = crypto.createHash("sha256").update(derivedBytes).digest("hex");
  const sessionId = `sess_${idHash.slice(0, 16)}`;
  const keyId = `key_${idHash.slice(16, 28)}`;

  return { encKeyBits, macKeyBits, sessionId, keyId };
}

describe("Milestone 2 — Secure Media Platform Integration Suite", () => {
  it("completes full E2EE Media flow: Alice encrypts media -> blind relay stores ciphertext -> Bob decrypts media", async () => {
    // 1. Setup in-memory media manager (blind relay)
    const storage = createInMemoryStorageProvider();
    const repo = createInMemoryMediaRepository();
    const mediaManager = new MediaManager({ ...repo, storageProvider: storage });

    // 2. Derive 1-on-1 E2EE session between Alice and Bob
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const aliceSession = await derivePairwiseKeys(alice.privateKey, bob.publicKey, "alice-id", "bob-id");
    const bobSession = await derivePairwiseKeys(bob.privateKey, alice.publicKey, "bob-id", "alice-id");

    // 3. Alice has an image/media file and encrypts it device-side
    const originalFileBytes = Buffer.from("PNG-FAKE-IMAGE-RAW-PIXEL-DATA-12345-67890");
    const mediaKey = generateMediaKey();
    const encMedia = encryptMedia(originalFileBytes, mediaKey);

    // 4. Alice uploads opaque encrypted ciphertext to /api/media (blind relay)
    const { media } = await mediaManager.uploadMedia({
      ownerId: "alice-id",
      conversationId: "conv-alice-bob",
      filename: "vacation.png",
      contentType: "image/png",
      ciphertext: encMedia.ciphertext,
      plaintextHash: encMedia.plaintextHash,
      plaintextSize: originalFileBytes.length,
      encryption: {
        keyFingerprint: mediaKeyFingerprint(mediaKey),
        iv: encMedia.iv.toString("base64"),
        authTag: encMedia.authTag.toString("base64"),
      },
    });

    assert.ok(media.mediaId, "Server must issue a mediaId");
    assert.equal(media.state, "available");

    // 5. Alice packages media descriptor (with mediaKey) inside the E2EE direct message payload
    const messagePayload = {
      text: "Check out this confidential photo!",
      media: {
        mediaId: media.mediaId,
        mediaKey: mediaKey.toString("base64"), // End-to-end encrypted with Bob!
        iv: encMedia.iv.toString("base64"),
        authTag: encMedia.authTag.toString("base64"),
        filename: "vacation.png",
        contentType: "image/png",
        size: originalFileBytes.length,
        plaintextHash: encMedia.plaintextHash,
      },
    };

    // Alice encrypts message payload with pairwise AES-256-GCM + HMAC-SHA256
    const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const nonce = toBase64(crypto.webcrypto.getRandomValues(new Uint8Array(16)));
    const meta = {
      v: 1,
      payloadVersion: 1,
      type: "message",
      protocolVersion: "1.0",
      sessionId: aliceSession.sessionId,
      keyId: aliceSession.keyId,
      senderDevice: "alice_device",
      receiverDevice: "bob_device",
      timestamp: Date.now(),
      nonce,
    };
    const aad = buildCanonicalAAD(meta);

    const aesKey = await subtle.importKey("raw", aliceSession.encKeyBits, "AES-GCM", false, ["encrypt"]);
    const encryptedBuf = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      aesKey,
      new TextEncoder().encode(JSON.stringify(messagePayload))
    );
    const encryptedBytes = new Uint8Array(encryptedBuf);
    const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
    const tag = encryptedBytes.slice(encryptedBytes.length - 16);

    const hmacKey = await subtle.importKey("raw", aliceSession.macKeyBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hmacInput = Buffer.concat([Buffer.from(aad), Buffer.from(iv), Buffer.from(ciphertext), Buffer.from(tag)]);
    const macBytes = new Uint8Array(await subtle.sign("HMAC", hmacKey, hmacInput));

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
        mac: toBase64(macBytes),
      },
      ratchet: null,
    };

    // 6. Server Relays direct message (blind relay, holds no keys)
    const relayResult = relayManager.relay(securePayload, { sessionId: aliceSession.sessionId });
    assert.ok(relayResult.payload);
    const storedDoc = toStoredCiphertext(securePayload);
    assert.equal(storedDoc.text, undefined);
    assert.equal(storedDoc.image, undefined);

    // 7. Bob receives message and decrypts message payload
    const bobAad = buildCanonicalAAD({
      v: storedDoc.secure.v,
      payloadVersion: storedDoc.secure.payloadVersion,
      type: storedDoc.secure.type,
      protocolVersion: storedDoc.secure.protocolVersion,
      sessionId: storedDoc.secure.sessionId,
      keyId: storedDoc.secure.keyId,
      senderDevice: storedDoc.secure.senderDevice,
      receiverDevice: storedDoc.secure.receiverDevice,
      timestamp: storedDoc.secure.timestamp,
      nonce: storedDoc.secure.nonce,
    });

    const bobAesKey = await subtle.importKey("raw", bobSession.encKeyBits, "AES-GCM", false, ["decrypt"]);
    const bobCombined = Buffer.concat([
      Buffer.from(fromBase64(storedDoc.secure.ciphertext)),
      Buffer.from(fromBase64(storedDoc.secure.tag)),
    ]);
    const decryptedMessageBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(storedDoc.secure.iv), additionalData: bobAad, tagLength: 128 },
      bobAesKey,
      bobCombined
    );

    const decryptedMessage = JSON.parse(new TextDecoder().decode(decryptedMessageBuf));
    assert.equal(decryptedMessage.text, "Check out this confidential photo!");
    assert.ok(decryptedMessage.media);
    assert.equal(decryptedMessage.media.mediaId, media.mediaId);

    // 8. Bob fetches encrypted media blob from server
    const download = await mediaManager.downloadMedia({ mediaId: decryptedMessage.media.mediaId, actorId: "bob-id" });
    assert.equal(download.mediaId, media.mediaId);

    // 9. Bob decrypts media blob using recovered mediaKey
    const recoveredMediaKey = Buffer.from(decryptedMessage.media.mediaKey, "base64");
    const recoveredBytes = decryptMedia(
      {
        ciphertext: Buffer.from(download.ciphertext, "base64"),
        iv: download.encryption.iv,
        authTag: download.encryption.authTag,
      },
      recoveredMediaKey
    );

    // 10. Verify integrity and byte-for-byte correctness
    assert.equal(sha256(recoveredBytes), decryptedMessage.media.plaintextHash);
    assert.deepEqual(recoveredBytes, originalFileBytes);
  });

  it("verifies that media ciphertext tampering is detected and rejected on download/decryption", async () => {
    const storage = createInMemoryStorageProvider();
    const repo = createInMemoryMediaRepository();
    const mediaManager = new MediaManager({ ...repo, storageProvider: storage });

    const key = generateMediaKey();
    const original = Buffer.from("Sensitive financial chart");
    const enc = encryptMedia(original, key);

    const { media } = await mediaManager.uploadMedia({
      ownerId: "alice",
      ciphertext: enc.ciphertext,
      plaintextHash: enc.plaintextHash,
      encryption: {
        keyFingerprint: mediaKeyFingerprint(key),
        iv: enc.iv.toString("base64"),
        authTag: enc.authTag.toString("base64"),
      },
    });

    // Adversary modifies ciphertext byte in storage
    const tamperedCiphertext = Buffer.from(enc.ciphertext);
    tamperedCiphertext[5] ^= 0x5a;
    await storage.store(media.mediaId, tamperedCiphertext);

    const dl = await mediaManager.downloadMedia({ mediaId: media.mediaId, actorId: "bob" });

    // Decryption must throw integrity error due to AEAD tag failure
    assert.throws(
      () =>
        decryptMedia(
          {
            ciphertext: Buffer.from(dl.ciphertext, "base64"),
            iv: dl.encryption.iv,
            authTag: dl.encryption.authTag,
          },
          key
        ),
      /Failed to decrypt media/
    );
  });
});
