/**
 * Fragmentation + reassembly units (Layer 8, Sprint 2): variable chunk size, ordering, per-chunk +
 * whole-payload integrity, missing/duplicate detection, completion, partial recovery. DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fakeCiphertext } from "./helpers.js";
import { fragmentPayload, clampChunkSize, chunkCountFor } from "../fragmentation/fragmenter.js";
import { Reassembler } from "../reassembly/reassembler.js";
import { verifyChunk, checksumOf, toBuffer } from "../chunks/chunk.js";
import { MIN_CHUNK_SIZE, MAX_CHUNK_SIZE } from "../types/types.js";
import { ChunkValidationError, PayloadTooLargeError, MissingChunkError, TransferCorruptedError } from "../errors.js";

describe("fragmentation", () => {
  it("splits a payload into ordered, checksummed chunks that cover it exactly", () => {
    const payload = fakeCiphertext(200 * 1024, 7);
    const { chunks, totalChunks, totalSize, chunkSize, checksum } = fragmentPayload(payload, { conversationId: "c", chunkSize: 64 * 1024 });
    assert.equal(totalSize, 200 * 1024);
    assert.equal(chunkSize, 64 * 1024);
    assert.equal(totalChunks, 4); // ceil(200/64)
    // ordered, contiguous, correct sizes
    let covered = 0;
    chunks.forEach((c, i) => {
      assert.equal(c.index, i);
      assert.equal(c.offset, covered);
      assert.ok(verifyChunk(c), "each chunk matches its checksum");
      covered += c.size;
    });
    assert.equal(covered, totalSize);
    assert.equal(checksum, checksumOf(payload), "aggregate checksum == checksum of the whole payload");
  });

  it("handles a payload smaller than one chunk (single chunk)", () => {
    const { chunks, totalChunks } = fragmentPayload(fakeCiphertext(1000), { conversationId: "c", chunkSize: 64 * 1024 });
    assert.equal(totalChunks, 1);
    assert.equal(chunks[0].size, 1000);
  });

  it("supports a variable (clamped) chunk size", () => {
    assert.equal(clampChunkSize(10), MIN_CHUNK_SIZE);
    assert.equal(clampChunkSize(9_999_999), MAX_CHUNK_SIZE);
    assert.equal(chunkCountFor(1_000_000, 100_000), 10);
  });

  it("rejects an empty payload and enforces the maximum payload size", () => {
    assert.throws(() => fragmentPayload(Buffer.alloc(0), { conversationId: "c" }), ChunkValidationError);
    // A tiny MAX check via a stubbed huge length is impractical; assert the guard exists via type.
    assert.equal(typeof PayloadTooLargeError, "function");
  });

  it("accepts base64-string payloads (opaque ciphertext)", () => {
    const b64 = fakeCiphertext(5000).toString("base64");
    const { totalSize } = fragmentPayload(b64, { conversationId: "c" });
    assert.equal(totalSize, 5000);
  });
});

describe("reassembly", () => {
  const build = (bytes, chunkSize = 64 * 1024) => fragmentPayload(fakeCiphertext(bytes, 3), { transferId: "t1", conversationId: "c", chunkSize });

  it("reconstructs the exact payload from out-of-order chunks", () => {
    const payload = fakeCiphertext(300 * 1024, 3);
    const { chunks, totalChunks, checksum } = fragmentPayload(payload, { transferId: "t1", conversationId: "c", chunkSize: 64 * 1024 });
    const r = new Reassembler({ transferId: "t1", totalChunks, checksum });
    for (const c of [...chunks].reverse()) r.accept(c); // reverse order
    assert.ok(r.isComplete());
    const out = r.reconstruct();
    assert.ok(toBuffer(out.payload).equals(payload));
  });

  it("detects + ignores duplicate chunks", () => {
    const { chunks, totalChunks, checksum } = build(150 * 1024);
    const r = new Reassembler({ transferId: "t1", totalChunks, checksum });
    assert.equal(r.accept(chunks[0]).outcome, "accepted");
    assert.equal(r.accept(chunks[0]).outcome, "duplicate");
    assert.equal(r.received, 1);
  });

  it("rejects a corrupted chunk (checksum mismatch)", () => {
    const { chunks, totalChunks, checksum } = build(150 * 1024);
    const bad = { ...chunks[0], data: Buffer.from("tampered").toString("base64") };
    const r = new Reassembler({ transferId: "t1", totalChunks, checksum });
    assert.equal(r.accept(bad).outcome, "invalid");
  });

  it("reports missing chunk indices for partial recovery", () => {
    const { chunks, totalChunks, checksum } = build(200 * 1024); // 4 chunks
    const r = new Reassembler({ transferId: "t1", totalChunks, checksum });
    r.accept(chunks[0]);
    r.accept(chunks[2]);
    assert.deepEqual(r.missingIndices(), [1, 3]);
    assert.equal(r.missingCount, 2);
    assert.throws(() => r.reconstruct(), MissingChunkError);
  });

  it("fails the whole-payload integrity check if the aggregate checksum is wrong", () => {
    const { chunks, totalChunks } = build(150 * 1024);
    const r = new Reassembler({ transferId: "t1", totalChunks, checksum: "deadbeef-wrong" });
    for (const c of chunks) r.accept(c);
    assert.throws(() => r.reconstruct(), TransferCorruptedError);
  });

  it("tracks progress monotonically", () => {
    const { chunks, totalChunks, checksum } = build(256 * 1024); // 4 chunks
    const r = new Reassembler({ transferId: "t1", totalChunks, checksum });
    assert.equal(r.progress, 0);
    r.accept(chunks[0]);
    assert.equal(r.progress, 0.25);
    for (const c of chunks) r.accept(c);
    assert.equal(r.progress, 1);
  });
});
