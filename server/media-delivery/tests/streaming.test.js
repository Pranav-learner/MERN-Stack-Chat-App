/**
 * Streaming engine (Layer 11, Sprint 2): progressive playback, chunk reassembly + decrypt, buffer, seek,
 * pause/resume, session FSM, large media, integrity. DB-free (real Sprint-1 pipeline).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeEngine, uploadMedia, decryptMedia, countEvents } from "./helpers.js";
import { StreamingState, MediaDeliveryEventType } from "../types/types.js";
import { StreamBuffer } from "../buffering/buffer.js";
import { canStreamTransition } from "../streaming/streamingSession.js";

describe("stream buffer (pure)", () => {
  it("tracks contiguous buffered + next-to-fetch + fill ratio", () => {
    const b = new StreamBuffer({ chunkCount: 10, windowChunks: 4 });
    b.add(0).add(1).add(3);
    assert.equal(b.contiguousUpTo(), 1, "0,1 contiguous; 3 has a gap");
    assert.deepEqual(b.nextToFetch(), [2], "cursor 0, window 4 → need 2 (0,1 buffered, 3 buffered)");
    assert.ok(b.fillRatio() > 0 && b.fillRatio() <= 1);
    b.seek(5);
    assert.equal(b.cursor, 5);
  });

  it("isComplete when all chunks buffered", () => {
    const b = new StreamBuffer({ chunkCount: 3 });
    b.add(0).add(1).add(2);
    assert.ok(b.isComplete());
  });
});

describe("streaming FSM (pure)", () => {
  it("permits documented transitions + rejects illegal ones", () => {
    assert.ok(canStreamTransition(StreamingState.BUFFERING, StreamingState.PLAYING));
    assert.ok(canStreamTransition(StreamingState.PLAYING, StreamingState.PAUSED));
    assert.ok(canStreamTransition(StreamingState.PAUSED, StreamingState.PLAYING));
    assert.ok(!canStreamTransition(StreamingState.COMPLETED, StreamingState.SEEKING));
  });
});

describe("streaming through the engine", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeEngine({ chunkSize: 256 * 1024 });
  });

  it("streams a media object chunk-by-chunk, reassembles + decrypts to the original", async () => {
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(700 * 1024, 0x42), { contentType: "video/mp4" });
    const { session } = await ctx.api.startStreaming({ mediaId: media.mediaId, deviceId: "phone", actorId: "phone" });
    assert.equal(session.chunkCount, 3);
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.STREAMING_STARTED), 1);
    const parts = [];
    for (let i = 0; i < session.chunkCount; i++) {
      const r = await ctx.api.streamChunk({ sessionId: session.sessionId, index: i, actorId: "phone" });
      assert.equal(r.chunk.hash.length, 64, "per-chunk sha256 preserved");
      parts.push(Buffer.from(r.chunk.data, "base64"));
    }
    const ciphertext = Buffer.concat(parts);
    assert.ok(ciphertext.equals(media.ciphertext), "reassembled ciphertext matches");
    assert.equal((await ctx.api.getStreamingStatus({ sessionId: session.sessionId })).state, StreamingState.COMPLETED);
    // device decrypts the reassembled ciphertext
    const dec = decryptMedia({ ciphertext, iv: media.encryption.iv, authTag: media.encryption.authTag }, media.key);
    assert.ok(dec.equals(media.plaintext));
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.STREAMING_COMPLETED), 1);
    assert.ok(countEvents(ctx.captured, MediaDeliveryEventType.CHUNK_DELIVERED) >= 3);
  });

  it("supports mid-stream seek + pause + resume", async () => {
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(700 * 1024));
    const { session } = await ctx.api.startStreaming({ mediaId: media.mediaId, deviceId: "phone", actorId: "phone" });
    await ctx.api.streamChunk({ sessionId: session.sessionId, index: 0, actorId: "phone" });
    const sk = await ctx.api.seek({ sessionId: session.sessionId, index: 2, actorId: "phone" });
    assert.equal(sk.session.cursor, 2);
    assert.deepEqual(sk.nextToFetch, [2]);
    const paused = await ctx.api.pauseStreaming({ sessionId: session.sessionId, actorId: "phone" });
    assert.equal(paused.state, StreamingState.PAUSED);
    const resumed = await ctx.api.resumeStreaming({ sessionId: session.sessionId, actorId: "phone" });
    assert.equal(resumed.state, StreamingState.BUFFERING);
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.STREAMING_SEEKED), 1);
  });

  it("rejects an out-of-range chunk + unauthorized access", async () => {
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(1000));
    const { session } = await ctx.api.startStreaming({ mediaId: media.mediaId, deviceId: "phone", actorId: "phone" });
    await assert.rejects(() => ctx.api.streamChunk({ sessionId: session.sessionId, index: 99, actorId: "phone" }), /range|past end/i);
    await assert.rejects(() => ctx.api.streamChunk({ sessionId: session.sessionId, index: 0, actorId: "mallory" }), /not authorized/i);
  });

  it("streams a large (10MB) media object", async () => {
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(10 * 1024 * 1024, 7), { contentType: "video/mp4" });
    const { session } = await ctx.api.startStreaming({ mediaId: media.mediaId, deviceId: "phone", actorId: "phone" });
    assert.equal(session.chunkCount, 40);
    const parts = [];
    for (let i = 0; i < session.chunkCount; i++) parts.push(Buffer.from((await ctx.api.streamChunk({ sessionId: session.sessionId, index: i, actorId: "phone" })).chunk.data, "base64"));
    assert.ok(Buffer.concat(parts).equals(media.ciphertext));
  });
});
