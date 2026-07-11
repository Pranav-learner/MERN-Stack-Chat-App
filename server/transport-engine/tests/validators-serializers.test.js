/**
 * Validation + serialization (Layer 8, Sprint 2). Enforces the no-plaintext / no-secret invariant and
 * that DTOs never leak chunk bytes. DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fakeCiphertext } from "./helpers.js";
import {
  validateStartRequest,
  validatePayloadMeta,
  validateChunk,
  validateWireEnvelope,
  assertNoPlaintext,
  assertSender,
  assertParticipant,
  FORBIDDEN_KEYS,
  checkReplay,
} from "../validators/validators.js";
import { toPublicTransfer, toProgress, toChunkStatus } from "../serializers/serializer.js";
import { createChunk } from "../chunks/chunk.js";
import { buildChunkEnvelope } from "../transport/wire.js";
import { TransferState, TransferDirection } from "../types/types.js";

describe("validators", () => {
  it("accepts a well-formed start request + payload meta", () => {
    assert.ok(validateStartRequest({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", payload: fakeCiphertext(100) }));
    assert.ok(validatePayloadMeta({ totalSize: 1000, totalChunks: 2, chunkSize: 2048, kind: "image" }));
  });

  it("rejects bad refs, priorities, kinds, and sizes", () => {
    assert.throws(() => validateStartRequest({ conversationId: "", senderDeviceId: "a", receiverDeviceId: "b", payload: fakeCiphertext(1) }), /conversation/);
    assert.throws(() => validateStartRequest({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", payload: fakeCiphertext(1), priority: "urgent" }), /priority/);
    assert.throws(() => validatePayloadMeta({ totalSize: 0, totalChunks: 1 }), /totalSize/);
    assert.throws(() => validatePayloadMeta({ totalSize: 100, totalChunks: 0 }), /totalChunks/);
    assert.throws(() => validatePayloadMeta({ totalSize: 100, totalChunks: 1, kind: "hologram" }), /kind/);
  });

  it("validates chunk integrity + rejects a corrupted chunk", () => {
    const c = createChunk({ transferId: "t", conversationId: "c", index: 0, total: 2, offset: 0, data: fakeCiphertext(200) });
    assert.ok(validateChunk(c));
    assert.throws(() => validateChunk({ ...c, data: Buffer.from("tampered").toString("base64") }), /integrity|checksum/i);
    assert.throws(() => validateChunk({ ...c, index: 5 }), /ordering|index/i);
  });

  it("every forbidden key is rejected by the deep scan; checksum is allowed", () => {
    for (const key of FORBIDDEN_KEYS) {
      assert.throws(() => assertNoPlaintext({ a: { [key]: "leak" } }), new RegExp(key), `should reject "${key}"`);
    }
    assert.doesNotThrow(() => assertNoPlaintext({ checksum: "abc123", data: "opaque" }));
  });

  it("validates a chunk wire envelope + rejects plaintext in it", () => {
    const c = createChunk({ transferId: "t", conversationId: "c", index: 0, total: 1, offset: 0, data: fakeCiphertext(100) });
    const env = buildChunkEnvelope(c, { sender: "a", receiver: "b" }, {});
    assert.ok(validateWireEnvelope(env));
    assert.throws(() => validateWireEnvelope({ ...env, plaintext: "oops" }), /plaintext|secret/);
  });

  it("assertSender / assertParticipant guard ownership", () => {
    const t = { transferId: "t", senderDeviceId: "a", receiverDeviceId: "b" };
    assert.ok(assertSender(t, "a"));
    assert.throws(() => assertSender(t, "b"), /not the sender/);
    assert.ok(assertParticipant(t, "b"));
    assert.throws(() => assertParticipant(t, "c"), /not a participant/);
  });

  it("checkReplay is an inert placeholder", () => {
    assert.equal(checkReplay(), false);
  });
});

describe("serializers", () => {
  const t = {
    transferId: "t",
    conversationId: "c",
    senderDeviceId: "a",
    receiverDeviceId: "b",
    direction: TransferDirection.OUTBOUND,
    state: TransferState.COMPLETED,
    priority: "image",
    payloadMeta: { kind: "image", name: "x.jpg", totalSize: 1000, totalChunks: 4, chunkSize: 256, checksum: "abc" },
    chunksAcked: 4,
    bytesTransferred: 1000,
    createdAt: "t0",
    updatedAt: "t1",
  };

  it("transfer DTO carries progress + metadata, never chunk bytes", () => {
    const dto = toPublicTransfer(t);
    assert.equal(dto.progress, 1);
    assert.equal(dto.completed, true);
    assert.equal(dto.terminal, true);
    assert.equal(dto.data, undefined);
    assert.equal(dto.payloadMeta.name, "x.jpg");
  });

  it("progress view computes fraction from acked/received", () => {
    const p = toProgress({ ...t, state: TransferState.ACTIVE, chunksAcked: 2 });
    assert.equal(p.progress, 0.5);
    assert.equal(p.completedChunks, 2);
  });

  it("chunk status hides opaque data unless explicitly requested", () => {
    const c = createChunk({ transferId: "t", conversationId: "c", index: 0, total: 1, offset: 0, data: fakeCiphertext(50) });
    assert.equal(toChunkStatus(c).data, undefined);
    assert.ok(toChunkStatus(c, { includeData: true }).data);
  });
});
