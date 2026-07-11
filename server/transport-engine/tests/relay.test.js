/**
 * The server-side blind chunk relay (Layer 8, Sprint 2): open → relay chunks → pull → reassemble →
 * ack → complete, plus ownership guards + the no-plaintext invariant. DB-free (in-memory repository).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeIdGen, fakeCiphertext } from "./helpers.js";
import { createTransportRelayService } from "../api/relayService.js";
import { createInMemoryTransportRepository } from "../repository/inMemoryTransportRepository.js";
import { fragmentPayload } from "../fragmentation/fragmenter.js";
import { Reassembler } from "../reassembly/reassembler.js";
import { toBuffer } from "../chunks/chunk.js";
import { TransferState } from "../types/types.js";

describe("TransportRelayService", () => {
  let relay;
  beforeEach(() => {
    relay = createTransportRelayService({ repository: createInMemoryTransportRepository(), clock: makeClock().now, idGenerator: makeIdGen() });
  });

  async function relayFullPayload(payload, meta = { kind: "file" }) {
    const frag = fragmentPayload(payload, { conversationId: "c1" });
    const transfer = await relay.openTransfer({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", payloadMeta: { ...meta, totalSize: frag.totalSize, totalChunks: frag.totalChunks, chunkSize: frag.chunkSize, checksum: frag.checksum } });
    for (const chunk of frag.chunks) await relay.relayChunk({ actingDevice: "alice", transferId: transfer.transferId, chunk });
    return { transfer, frag };
  }

  it("relays chunks the receiver can pull + reassemble intact", async () => {
    const payload = fakeCiphertext(300 * 1024, 4);
    const { transfer, frag } = await relayFullPayload(payload, { kind: "image" });

    const { chunks, payloadMeta } = await relay.pullChunks({ actingDevice: "bob", transferId: transfer.transferId });
    assert.equal(chunks.length, frag.totalChunks);
    const r = new Reassembler({ transferId: transfer.transferId, totalChunks: payloadMeta.totalChunks, checksum: payloadMeta.checksum });
    for (const c of chunks) r.accept(c);
    assert.ok(toBuffer(r.reconstruct().payload).equals(payload), "receiver reassembles the exact payload");
  });

  it("completes the transfer once all chunks are acknowledged", async () => {
    const { transfer } = await relayFullPayload(fakeCiphertext(150 * 1024, 5));
    const { chunks } = await relay.pullChunks({ actingDevice: "bob", transferId: transfer.transferId });
    const { progress } = await relay.ackChunks({ actingDevice: "bob", transferId: transfer.transferId, chunkIds: chunks.map((c) => c.chunkId) });
    assert.equal(progress.progress, 1);
    assert.equal((await relay.getTransfer({ actingDevice: "alice", transferId: transfer.transferId })).state, TransferState.COMPLETED);
  });

  it("enforces ownership: only sender relays, only receiver pulls + acks", async () => {
    const { transfer, frag } = await relayFullPayload(fakeCiphertext(64 * 1024, 2));
    await assert.rejects(() => relay.relayChunk({ actingDevice: "bob", transferId: transfer.transferId, chunk: frag.chunks[0] }), /not the sender/);
    await assert.rejects(() => relay.pullChunks({ actingDevice: "alice", transferId: transfer.transferId }), /receiver/);
    await assert.rejects(() => relay.ackChunks({ actingDevice: "alice", transferId: transfer.transferId, chunkIds: [] }), /receiver/);
  });

  it("rejects a corrupted or plaintext-bearing chunk", async () => {
    const frag = fragmentPayload(fakeCiphertext(64 * 1024), { conversationId: "c1" });
    const transfer = await relay.openTransfer({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", payloadMeta: { kind: "file", totalSize: frag.totalSize, totalChunks: frag.totalChunks, chunkSize: frag.chunkSize, checksum: frag.checksum } });
    await assert.rejects(() => relay.relayChunk({ actingDevice: "alice", transferId: transfer.transferId, chunk: { ...frag.chunks[0], data: Buffer.from("tampered").toString("base64") } }), /integrity|checksum/i);
  });

  it("pause / resume / cancel + diagnostics", async () => {
    const { transfer } = await relayFullPayload(fakeCiphertext(128 * 1024, 7));
    assert.equal((await relay.pauseTransfer({ actingDevice: "alice", transferId: transfer.transferId })).state, TransferState.PAUSED);
    assert.equal((await relay.resumeTransfer({ actingDevice: "alice", transferId: transfer.transferId })).state, TransferState.ACTIVE);
    assert.equal((await relay.cancelTransfer({ actingDevice: "bob", transferId: transfer.transferId })).state, TransferState.CANCELLED);
    const diag = await relay.getDiagnostics({ conversationId: "c1" });
    assert.equal(diag.canDecrypt, false);
    assert.equal(diag.total, 1);
  });

  it("lists active transfers for a participant", async () => {
    await relayFullPayload(fakeCiphertext(50 * 1024));
    assert.ok((await relay.listActiveTransfers({ actingDevice: "alice" })).length >= 1);
    assert.ok((await relay.listActiveTransfers({ actingDevice: "bob" })).length >= 1);
  });
});
