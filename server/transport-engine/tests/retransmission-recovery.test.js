/**
 * Retransmission + failure recovery (Layer 8, Sprint 2): lost-chunk recovery, ACK-timeout retransmit,
 * max-retry → transfer FAILED, TTL expiry, and pause / resume / cancel. DB-free, deterministic clock.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, fakeCiphertext, countEvents } from "./helpers.js";
import { TransferState, TransportEventType, TransferFailureReason } from "../types/types.js";

describe("loss recovery", () => {
  it("recovers a dropped chunk via retransmission and delivers the payload intact", async () => {
    const mesh = makeMesh({ options: { windowSize: 4, chunkSize: 32 * 1024, chunkAckTimeoutMs: 1000 } });
    let dropped = 0;
    mesh.net.setDrop((env) => env.type === "chunk" && env.index === 2 && dropped++ < 2); // drop chunk 2 twice
    const payload = fakeCiphertext(200 * 1024, 8); // ~7 chunks
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
    await mesh.net.flush();
    // chunk 2 was dropped → not complete yet.
    assert.notEqual((await mesh.engines.alice.getTransfer(transfer.transferId)).state, TransferState.COMPLETED);
    // Sweep retransmits the timed-out chunk.
    for (let i = 0; i < 4; i++) {
      mesh.clock.advance(2000);
      await mesh.engines.alice.sweepTimeouts();
      await mesh.net.flush();
    }
    assert.equal((await mesh.engines.alice.getTransfer(transfer.transferId)).state, TransferState.COMPLETED);
    assert.ok(Buffer.from(mesh.received.bob[0].payload, "base64").equals(payload));
    assert.ok(countEvents(mesh.events.alice, TransportEventType.CHUNK_RETRIED) >= 2);
  });

  it("fails the transfer after a chunk exhausts its retries", async () => {
    const mesh = makeMesh({ options: { windowSize: 2, chunkSize: 32 * 1024, chunkAckTimeoutMs: 1000, maxChunkRetries: 2 } });
    mesh.net.setDrop(() => true); // drop everything permanently
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload: fakeCiphertext(100 * 1024, 3), payloadMeta: { kind: "file" } });
    await mesh.net.flush();
    for (let i = 0; i < 5; i++) {
      mesh.clock.advance(2000);
      await mesh.engines.alice.sweepTimeouts();
    }
    const t = await mesh.engines.alice.getTransfer(transfer.transferId);
    assert.equal(t.state, TransferState.FAILED);
    assert.equal(countEvents(mesh.events.alice, TransportEventType.TRANSFER_FAILED), 1);
  });

  it("expires an incomplete transfer past its TTL", async () => {
    const mesh = makeMesh({ options: { windowSize: 2, chunkSize: 32 * 1024, ttlMs: 5000 } });
    mesh.net.setDrop(() => true);
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload: fakeCiphertext(80 * 1024, 4), payloadMeta: { kind: "file" } });
    mesh.clock.advance(6000);
    const swept = await mesh.engines.alice.sweepTimeouts();
    assert.equal(swept.expired, 1);
    assert.equal((await mesh.engines.alice.getTransfer(transfer.transferId)).state, TransferState.EXPIRED);
  });
});

describe("pause / resume / cancel", () => {
  it("pauses a transfer mid-flight and resumes it to completion", async () => {
    const mesh = makeMesh({ options: { windowSize: 2, chunkSize: 16 * 1024 } });
    const payload = fakeCiphertext(160 * 1024, 5); // 10 chunks, window 2
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
    await mesh.engines.alice.pauseTransfer(transfer.transferId);
    await mesh.net.flush(); // deliver already-sent window; acks come back but paused → no more sent
    const paused = await mesh.engines.alice.getTransfer(transfer.transferId);
    assert.equal(paused.state, TransferState.PAUSED);
    assert.ok(paused.chunksAcked < transfer.payloadMeta.totalChunks, "not finished while paused");
    assert.equal(countEvents(mesh.events.alice, TransportEventType.TRANSFER_PAUSED), 1);

    await mesh.engines.alice.resumeTransfer(transfer.transferId);
    await mesh.net.flush();
    assert.equal((await mesh.engines.alice.getTransfer(transfer.transferId)).state, TransferState.COMPLETED);
    assert.ok(Buffer.from(mesh.received.bob[0].payload, "base64").equals(payload));
    assert.equal(countEvents(mesh.events.alice, TransportEventType.TRANSFER_RESUMED), 1);
  });

  it("cancels a transfer (no completion, no delivered payload on the sender side)", async () => {
    const mesh = makeMesh({ options: { windowSize: 2, chunkSize: 16 * 1024 } });
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload: fakeCiphertext(160 * 1024, 6), payloadMeta: { kind: "file" } });
    const cancelled = await mesh.engines.alice.cancelTransfer(transfer.transferId);
    assert.equal(cancelled.state, TransferState.CANCELLED);
    assert.equal(cancelled.failureReason, TransferFailureReason.CANCELLED);
    await mesh.net.flush();
    // The sender's transfer stays cancelled regardless of stray in-flight acks.
    assert.equal((await mesh.engines.alice.getTransfer(transfer.transferId)).state, TransferState.CANCELLED);
    assert.equal(countEvents(mesh.events.alice, TransportEventType.TRANSFER_CANCELLED), 1);
  });

  it("guards participant-only control", async () => {
    const mesh = makeMesh({ devices: ["alice", "bob"], options: { chunkSize: 16 * 1024 } });
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload: fakeCiphertext(20 * 1024), payloadMeta: { kind: "file" } });
    await assert.rejects(() => mesh.engines.alice.cancelTransfer(transfer.transferId, { actingDevice: "mallory" }), /not a participant/);
  });
});
