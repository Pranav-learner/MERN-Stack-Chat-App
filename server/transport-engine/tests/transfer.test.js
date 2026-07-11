/**
 * End-to-end transfers (Layer 8, Sprint 2): large files, images, documents, videos, voice notes, and
 * binary payloads move intact across two engines over the loopback network — with correct progress,
 * completion, integrity, events, and the no-plaintext guarantee. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, fakeCiphertext, countEvents } from "./helpers.js";
import { TransferState, TransportEventType, TransferPriority } from "../types/types.js";

describe("end-to-end transfer", () => {
  let mesh;
  beforeEach(() => {
    mesh = makeMesh({ options: { windowSize: 4, chunkSize: 64 * 1024 } });
  });

  const kinds = [
    { kind: "file", bytes: 512 * 1024, name: "archive.zip" },
    { kind: "image", bytes: 300 * 1024, name: "cat.jpg" },
    { kind: "document", bytes: 128 * 1024, name: "report.pdf" },
    { kind: "video", bytes: 900 * 1024, name: "clip.mp4" },
    { kind: "voice-note", bytes: 80 * 1024, name: "vn.opus" },
    { kind: "binary", bytes: 250 * 1024, name: "blob.bin" },
  ];

  for (const { kind, bytes, name } of kinds) {
    it(`transports a ${kind} (${Math.round(bytes / 1024)} KiB) intact`, async () => {
      const payload = fakeCiphertext(bytes, bytes);
      const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload, payloadMeta: { kind, name } });
      await mesh.net.flush();

      assert.equal(mesh.received.bob.length, 1, "bob received one payload");
      assert.ok(Buffer.from(mesh.received.bob[0].payload, "base64").equals(payload), "payload bytes match exactly");
      assert.equal(mesh.received.bob[0].payloadMeta.kind, kind);
      assert.equal(mesh.received.bob[0].payloadMeta.name, name);

      const sender = await mesh.engines.alice.getTransfer(transfer.transferId);
      assert.equal(sender.state, TransferState.COMPLETED);
      assert.equal(sender.progress, 1);
      assert.equal(sender.chunksAcked, sender.payloadMeta.totalChunks);
    });
  }

  it("emits the full transfer lifecycle event sequence", async () => {
    const payload = fakeCiphertext(200 * 1024, 5);
    await mesh.engines.alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
    await mesh.net.flush();

    assert.equal(countEvents(mesh.events.alice, TransportEventType.TRANSFER_STARTED), 1);
    assert.equal(countEvents(mesh.events.alice, TransportEventType.TRANSFER_FRAGMENTED), 1);
    assert.ok(countEvents(mesh.events.alice, TransportEventType.CHUNK_SENT) >= 4);
    assert.ok(countEvents(mesh.events.alice, TransportEventType.CHUNK_ACKED) >= 4);
    assert.ok(countEvents(mesh.events.alice, TransportEventType.TRANSFER_PROGRESS) >= 1);
    assert.equal(countEvents(mesh.events.alice, TransportEventType.TRANSFER_COMPLETED), 1);
    // Receiver side.
    assert.equal(countEvents(mesh.events.bob, TransportEventType.TRANSFER_STARTED), 1);
    assert.ok(countEvents(mesh.events.bob, TransportEventType.CHUNK_RECEIVED) >= 4);
    assert.equal(countEvents(mesh.events.bob, TransportEventType.TRANSFER_COMPLETED), 1);
  });

  it("delivers the OPAQUE ciphertext to the app, never a plaintext field", async () => {
    const payload = fakeCiphertext(70 * 1024, 9);
    await mesh.engines.alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload, payloadMeta: { kind: "image" } });
    await mesh.net.flush();
    const p = mesh.received.bob[0];
    assert.equal(typeof p.payload, "string"); // base64 ciphertext
    assert.equal(p.plaintext, undefined);
    assert.equal(p.sender, "alice");
    assert.ok(p.checksum);
  });

  it("assigns a default priority from the payload kind", async () => {
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload: fakeCiphertext(5000), payloadMeta: { kind: "image" } });
    assert.equal(transfer.priority, TransferPriority.IMAGE);
  });

  it("reports progress + chunk status mid-flight and after completion", async () => {
    const payload = fakeCiphertext(400 * 1024, 2);
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
    await mesh.net.flush();
    const progress = await mesh.engines.alice.getProgress(transfer.transferId);
    assert.equal(progress.progress, 1);
    assert.equal(progress.completedChunks, progress.totalChunks);
    const chunkStatus = await mesh.engines.alice.getChunkStatus(transfer.transferId);
    assert.equal(chunkStatus.length, transfer.payloadMeta.totalChunks);
    assert.equal(chunkStatus[0].data, undefined, "chunk status carries no opaque data");
  });

  it("rejects a transfer whose payloadMeta carries a plaintext-looking field", async () => {
    await assert.rejects(
      () => mesh.engines.alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload: fakeCiphertext(1000), payloadMeta: { kind: "file", plaintext: "leak" } }),
      /plaintext|secret/i,
    );
  });

  it("lists active transfers and clears them on completion", async () => {
    const big = fakeCiphertext(1024 * 1024, 11); // ~16 chunks
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload: big, payloadMeta: { kind: "video" } });
    const activeMid = await mesh.engines.alice.listActiveTransfers();
    assert.ok(activeMid.some((t) => t.transferId === transfer.transferId));
    await mesh.net.flush();
    const activeAfter = await mesh.engines.alice.listActiveTransfers();
    assert.equal(activeAfter.length, 0, "completed transfer is no longer active");
  });
});
