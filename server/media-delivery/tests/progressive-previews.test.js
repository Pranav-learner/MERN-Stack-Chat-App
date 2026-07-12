/**
 * Progressive transfers + thumbnails + previews (Layer 11, Sprint 2): progressive download with window +
 * resume, progressive upload round-trip through Sprint 1, thumbnail/preview generation (async pluggable),
 * preview cache, versions. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeEngine, uploadMedia, decryptMedia, encryptMedia, generateMediaKey, mediaKeyFingerprint, sha256, countEvents } from "./helpers.js";
import { TransferState, PreviewKind, PreviewState, MediaDeliveryEventType } from "../types/types.js";
import { receiveChunk, missingChunks, createTransfer } from "../progressive/progressiveTransfer.js";
import { kindForContentType } from "../thumbnails/thumbnailEngine.js";

describe("progressive transfer (pure)", () => {
  it("receiveChunk is idempotent + tracks missing", () => {
    let t = createTransfer({ mediaId: "m", direction: "download", deviceId: "d", bytesTotal: 3 * 256 * 1024, chunkSize: 256 * 1024 });
    assert.equal(t.chunkCount, 3);
    t = receiveChunk(t, { index: 0, length: 100 }).transfer;
    const dup = receiveChunk(t, { index: 0, length: 100 });
    assert.equal(dup.isNew, false, "duplicate chunk not re-counted");
    assert.deepEqual(missingChunks(dup.transfer), [1, 2]);
    const full = receiveChunk(receiveChunk(t, { index: 1, length: 1 }).transfer, { index: 2, length: 1 });
    assert.equal(full.complete, true);
  });
});

describe("progressive download through the engine", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeEngine({ chunkSize: 256 * 1024 });
  });

  it("downloads with a window, resumes only the missing chunks, completes", async () => {
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(700 * 1024, 5));
    const { transfer, nextWindow } = await ctx.api.startTransfer({ mediaId: media.mediaId, deviceId: "laptop", actorId: "laptop", direction: "download", priority: "high" });
    assert.equal(transfer.state, TransferState.ACTIVE);
    assert.ok(nextWindow.length >= 1);
    await ctx.api.fetchChunk({ transferId: transfer.transferId, index: 0, actorId: "laptop" });
    const res = await ctx.api.resumeTransfer({ transferId: transfer.transferId, actorId: "laptop" });
    assert.deepEqual(res.missing, [1, 2], "resume lists only the gaps");
    const parts = [Buffer.from((await ctx.api.fetchChunk({ transferId: transfer.transferId, index: 0, actorId: "laptop" })).chunk.data, "base64")];
    for (const i of res.missing) parts.push(Buffer.from((await ctx.api.fetchChunk({ transferId: transfer.transferId, index: i, actorId: "laptop" })).chunk.data, "base64"));
    assert.equal((await ctx.api.getTransferStatus({ transferId: transfer.transferId })).state, TransferState.COMPLETED);
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.TRANSFER_COMPLETED), 1);
  });
});

describe("progressive upload through the engine (into Sprint 1)", () => {
  it("uploads chunks + assembles + stores via the Sprint-1 pipeline; the result decrypts", async () => {
    const ctx = makeEngine({ chunkSize: 256 * 1024 });
    const key = generateMediaKey();
    const plaintext = Buffer.alloc(600 * 1024, 9);
    const enc = encryptMedia(plaintext, key);
    const cs = 256 * 1024, cc = Math.ceil(enc.ciphertext.length / cs);
    const { transfer } = await ctx.api.startTransfer({ mediaId: "up-1", deviceId: "phone", actorId: "phone", direction: "upload", bytesTotal: enc.ciphertext.length, chunkSize: cs, contentType: "image/png" });
    for (let i = 0; i < cc; i++) {
      const b = enc.ciphertext.subarray(i * cs, (i + 1) * cs);
      const r = await ctx.api.uploadChunk({ transferId: transfer.transferId, index: i, data: b.toString("base64"), hash: sha256(b), actorId: "phone" });
      if (i < cc - 1) assert.equal(r.complete, false);
    }
    const done = await ctx.api.completeUpload({ transferId: transfer.transferId, upload: { mediaId: "up-1", conversationId: "conv1", filename: "u.png", contentType: "image/png", plaintextHash: enc.plaintextHash, encryption: { keyFingerprint: mediaKeyFingerprint(key), iv: enc.iv.toString("base64"), authTag: enc.authTag.toString("base64") } }, actorId: "phone" });
    assert.equal(done.media.state, "available");
    // download it back through Sprint 1 + decrypt
    const dl = await ctx.mediaManager.downloadMedia({ mediaId: done.media.mediaId, actorId: "phone" });
    const recovered = decryptMedia({ ciphertext: Buffer.from(dl.ciphertext, "base64"), iv: dl.encryption.iv, authTag: dl.encryption.authTag }, key);
    assert.ok(recovered.equals(plaintext));
  });

  it("rejects completion with missing chunks + a bad chunk hash", async () => {
    const ctx = makeEngine();
    const { transfer } = await ctx.api.startTransfer({ mediaId: "up-2", deviceId: "phone", actorId: "phone", direction: "upload", bytesTotal: 2 * 256 * 1024, chunkSize: 256 * 1024 });
    await assert.rejects(() => ctx.api.completeUpload({ transferId: transfer.transferId, actorId: "phone" }), /incomplete|missing/i);
    await assert.rejects(() => ctx.api.uploadChunk({ transferId: transfer.transferId, index: 0, data: Buffer.from("x").toString("base64"), hash: "deadbeef".repeat(8), actorId: "phone" }), /integrity/i);
  });
});

describe("thumbnails + previews (async pluggable)", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeEngine();
  });

  it("kindForContentType maps MIME → preview kind", () => {
    assert.equal(kindForContentType("image/png"), PreviewKind.IMAGE_THUMBNAIL);
    assert.equal(kindForContentType("video/mp4"), PreviewKind.VIDEO_THUMBNAIL);
    assert.equal(kindForContentType("application/pdf"), PreviewKind.DOCUMENT_PREVIEW);
    assert.equal(kindForContentType("audio/mpeg"), PreviewKind.AUDIO_ARTWORK);
  });

  it("generates a thumbnail (metadata-only default) + bumps version + caches", async () => {
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(1000), { contentType: "image/jpeg" });
    const t1 = await ctx.api.generateThumbnail({ mediaId: media.mediaId, actorId: "alice" });
    assert.equal(t1.kind, PreviewKind.IMAGE_THUMBNAIL);
    assert.equal(t1.state, PreviewState.READY);
    assert.equal(t1.version, 1);
    assert.ok(t1.metadata.width && t1.metadata.height);
    const t2 = await ctx.api.generateThumbnail({ mediaId: media.mediaId, actorId: "alice" });
    assert.equal(t2.version, 2, "regeneration bumps the version");
    const cached = await ctx.api.getPreview({ mediaId: media.mediaId, actorId: "alice" });
    assert.equal(cached.version, 2);
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.THUMBNAIL_GENERATED), 2);
  });

  it("generates a document preview + supports an injected generator", async () => {
    const ctx2 = makeEngine({ previewGenerator: async () => ({ metadata: { pages: 12, custom: true } }) });
    const media = await uploadMedia(ctx2.mediaManager, Buffer.alloc(1000), { contentType: "application/pdf" });
    const p = await ctx2.api.generatePreview({ mediaId: media.mediaId, actorId: "alice" });
    assert.equal(p.kind, PreviewKind.DOCUMENT_PREVIEW);
    assert.equal(p.metadata.pages, 12);
  });

  it("a failing generator marks the preview FAILED (corrupted source)", async () => {
    const ctx2 = makeEngine({ thumbnailGenerator: async () => { throw new Error("corrupt image"); } });
    const media = await uploadMedia(ctx2.mediaManager, Buffer.alloc(1000), { contentType: "image/png" });
    const t = await ctx2.api.generateThumbnail({ mediaId: media.mediaId, actorId: "alice" });
    assert.equal(t.state, PreviewState.FAILED);
    assert.equal(countEvents(ctx2.captured, MediaDeliveryEventType.PREVIEW_FAILED), 1);
  });
});
