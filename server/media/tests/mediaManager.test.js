import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MediaManager,
  generateMediaKey,
  encryptMedia,
  decryptMedia,
  mediaKeyFingerprint,
  sha256,
  createInMemoryMediaRepository,
  createInMemoryStorageProvider,
  MediaNotFoundError,
  MediaIntegrityError,
} from "../index.js";

describe("Layer 11 Sprint 1 — Secure Media Manager (Regression Suite)", () => {
  let mediaManager;
  let storage;
  let repo;

  beforeEach(() => {
    storage = createInMemoryStorageProvider();
    repo = createInMemoryMediaRepository();
    mediaManager = new MediaManager({
      ...repo,
      storageProvider: storage,
    });
  });

  it("successfully uploads and stores encrypted media", async () => {
    const key = generateMediaKey();
    const plaintext = Buffer.from("Secret document payload for audit");
    const enc = encryptMedia(plaintext, key);

    const { media, operation } = await mediaManager.uploadMedia({
      ownerId: "user-alice",
      conversationId: "conv-123",
      filename: "secret.txt",
      contentType: "text/plain",
      ciphertext: enc.ciphertext,
      plaintextHash: enc.plaintextHash,
      plaintextSize: plaintext.length,
      encryption: {
        keyFingerprint: mediaKeyFingerprint(key),
        iv: enc.iv.toString("base64"),
        authTag: enc.authTag.toString("base64"),
      },
    });

    assert.ok(media.mediaId);
    assert.equal(media.state, "available");
    assert.equal(media.size, enc.ciphertext.length);
    assert.equal(operation.state, "completed");

    const dl = await mediaManager.downloadMedia({ mediaId: media.mediaId, actorId: "user-alice" });
    assert.equal(dl.mediaId, media.mediaId);

    const recovered = decryptMedia(
      {
        ciphertext: Buffer.from(dl.ciphertext, "base64"),
        iv: dl.encryption.iv,
        authTag: dl.encryption.authTag,
      },
      key
    );

    assert.equal(recovered.toString(), plaintext.toString());
  });

  it("verifies media integrity and detects tampered ciphertext", async () => {
    const key = generateMediaKey();
    const plaintext = Buffer.from("Integrity check test payload");
    const enc = encryptMedia(plaintext, key);

    const { media } = await mediaManager.uploadMedia({
      ownerId: "user-alice",
      ciphertext: enc.ciphertext,
      plaintextHash: enc.plaintextHash,
      plaintextSize: plaintext.length,
      encryption: {
        keyFingerprint: mediaKeyFingerprint(key),
        iv: enc.iv.toString("base64"),
        authTag: enc.authTag.toString("base64"),
      },
    });

    const report = await mediaManager.verifyMedia({ mediaId: media.mediaId, actorId: "user-alice" });
    assert.equal(report.valid, true);

    // Tamper with the stored ciphertext
    const tampered = Buffer.from(enc.ciphertext);
    tampered[0] ^= 0xff;
    await storage.store(media.mediaId, tampered);

    await assert.rejects(
      () => mediaManager.verifyMedia({ mediaId: media.mediaId, actorId: "user-alice" }),
      (err) => err instanceof MediaIntegrityError
    );
  });

  it("throws 404 MediaNotFoundError on missing mediaId", async () => {
    await assert.rejects(
      () => mediaManager.getMetadata({ mediaId: "nonexistent-id", actorId: "alice" }),
      (err) => err instanceof MediaNotFoundError && err.status === 404
    );
  });

  it("supports soft deletion of media and clears storage", async () => {
    const key = generateMediaKey();
    const enc = encryptMedia(Buffer.from("Delete test"), key);
    const { media } = await mediaManager.uploadMedia({
      ownerId: "user-bob",
      ciphertext: enc.ciphertext,
      plaintextHash: enc.plaintextHash,
      encryption: {
        keyFingerprint: mediaKeyFingerprint(key),
        iv: enc.iv.toString("base64"),
        authTag: enc.authTag.toString("base64"),
      },
    });

    const deleted = await mediaManager.deleteMedia({ mediaId: media.mediaId, actorId: "user-bob" });
    assert.equal(deleted.state, "deleted");

    const exists = await storage.has(media.mediaId);
    assert.equal(exists, false);

    await assert.rejects(
      () => mediaManager.getMetadata({ mediaId: media.mediaId }),
      (err) => err instanceof MediaNotFoundError
    );
  });

  it("reports healthy diagnostics and health metrics", async () => {
    const h = await mediaManager.health();
    assert.equal(h.status, "healthy");
    assert.equal(h.ready, true);
  });
});
