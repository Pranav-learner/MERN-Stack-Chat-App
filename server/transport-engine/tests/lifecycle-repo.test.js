/**
 * Transfer + chunk FSMs and the in-memory repository contract (Layer 8, Sprint 2). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { fakeCiphertext } from "./helpers.js";
import { createInMemoryTransportRepository } from "../repository/inMemoryTransportRepository.js";
import { createChunk } from "../chunks/chunk.js";
import {
  canTransferTransition,
  assertTransferTransition,
  canChunkTransition,
  assertChunkTransition,
  TransferLifecycle,
} from "../lifecycle/lifecycle.js";
import { TransferState, ChunkState, TransferDirection } from "../types/types.js";

describe("transfer FSM", () => {
  it("permits the happy path + pause loop", () => {
    assert.ok(canTransferTransition(TransferState.CREATED, TransferState.FRAGMENTING));
    assert.ok(canTransferTransition(TransferState.FRAGMENTING, TransferState.ACTIVE));
    assert.ok(canTransferTransition(TransferState.ACTIVE, TransferState.PAUSED));
    assert.ok(canTransferTransition(TransferState.PAUSED, TransferState.ACTIVE));
    assert.ok(canTransferTransition(TransferState.ACTIVE, TransferState.COMPLETED));
    assert.ok(canTransferTransition(TransferState.REASSEMBLING, TransferState.COMPLETED));
    assert.ok(canTransferTransition(TransferState.COMPLETED, TransferState.DESTROYED));
  });

  it("rejects illegal transitions", () => {
    assert.equal(canTransferTransition(TransferState.COMPLETED, TransferState.ACTIVE), false);
    assert.equal(canTransferTransition(TransferState.CREATED, TransferState.COMPLETED), false);
    assert.throws(() => assertTransferTransition(TransferState.COMPLETED, TransferState.ACTIVE), /Cannot transition/);
    assert.throws(() => assertTransferTransition(TransferState.ACTIVE, "bogus"), /Unknown transfer state/);
  });

  it("chunk FSM: pending → scheduled → sent → acked; retransmit + fail loops", () => {
    assert.ok(canChunkTransition(ChunkState.PENDING, ChunkState.SENT));
    assert.ok(canChunkTransition(ChunkState.SENT, ChunkState.ACKED));
    assert.ok(canChunkTransition(ChunkState.SENT, ChunkState.SENT), "retransmit (self)");
    assert.ok(canChunkTransition(ChunkState.SENT, ChunkState.FAILED));
    assert.equal(canChunkTransition(ChunkState.ACKED, ChunkState.SENT), false);
    assert.throws(() => assertChunkTransition(ChunkState.ACKED, ChunkState.PENDING), /Cannot transition/);
  });

  it("TransferLifecycle records history", () => {
    const fsm = new TransferLifecycle();
    fsm.transition(TransferState.FRAGMENTING);
    fsm.transition(TransferState.ACTIVE);
    fsm.transition(TransferState.COMPLETED, { reason: "done" });
    assert.equal(fsm.state, TransferState.COMPLETED);
    assert.equal(fsm.isTerminal, true);
    assert.equal(fsm.history.length, 3);
  });
});

describe("in-memory repository contract", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryTransportRepository();
  });

  const mkTransfer = (over = {}) => ({
    transferId: "t-0001",
    conversationId: "c",
    senderDeviceId: "alice",
    receiverDeviceId: "bob",
    direction: TransferDirection.OUTBOUND,
    state: TransferState.ACTIVE,
    priority: "file",
    payloadMeta: { totalChunks: 3, totalSize: 300, chunkSize: 100 },
    chunksAcked: 0,
    chunksReceived: 0,
    bytesTransferred: 0,
    createdAt: new Date(1000).toISOString(),
    expiresAt: new Date(9_000_000_000_000).toISOString(),
    version: 1,
    ...over,
  });

  it("transfers: create/find/update/delete + active/participant/conversation listing", async () => {
    await repo.transfers.create(mkTransfer());
    assert.equal((await repo.transfers.findById("t-0001")).state, TransferState.ACTIVE);
    await repo.transfers.update("t-0001", { chunksAcked: 2 });
    assert.equal((await repo.transfers.findById("t-0001")).chunksAcked, 2);
    assert.equal((await repo.transfers.listActive("alice")).length, 1);
    assert.equal((await repo.transfers.listActive("carol")).length, 0);
    assert.equal((await repo.transfers.listByParticipant("bob")).length, 1);
    assert.equal((await repo.transfers.listByConversation("c")).length, 1);
    assert.equal(await repo.transfers.delete("t-0001"), true);
    assert.equal(await repo.transfers.findById("t-0001"), null);
  });

  it("transfers: listExpired + countByState", async () => {
    await repo.transfers.create(mkTransfer({ transferId: "old", expiresAt: new Date(1000).toISOString() }));
    await repo.transfers.create(mkTransfer({ transferId: "fresh" }));
    const expired = await repo.transfers.listExpired(new Date(2000).toISOString());
    assert.deepEqual(expired.map((t) => t.transferId), ["old"]);
    assert.deepEqual(await repo.transfers.countByState(), { active: 2 });
  });

  it("chunks: upsert/find/update + retry-due + countByState + deleteByTransfer", async () => {
    const c0 = createChunk({ transferId: "t-0001", conversationId: "c", index: 0, total: 2, offset: 0, data: fakeCiphertext(100) });
    const c1 = createChunk({ transferId: "t-0001", conversationId: "c", index: 1, total: 2, offset: 100, data: fakeCiphertext(100) });
    await repo.chunks.upsert({ ...c0, state: ChunkState.SENT, nextRetryAt: new Date(1000).toISOString() });
    await repo.chunks.upsert({ ...c1, state: ChunkState.PENDING });
    assert.equal((await repo.chunks.findByTransfer("t-0001")).length, 2);
    assert.equal((await repo.chunks.findByTransfer("t-0001", { states: [ChunkState.SENT] })).length, 1);
    const due = await repo.chunks.listRetryDue("t-0001", new Date(5000).toISOString());
    assert.deepEqual(due.map((c) => c.index), [0]);
    await repo.chunks.update(c0.chunkId, { state: ChunkState.ACKED });
    assert.deepEqual(await repo.chunks.countByState("t-0001"), { acked: 1, pending: 1 });
    assert.equal(await repo.chunks.deleteByTransfer("t-0001"), 2);
  });

  it("stores records by deep copy (mutation isolation)", async () => {
    const t = mkTransfer();
    await repo.transfers.create(t);
    t.payloadMeta.totalChunks = 999;
    assert.equal((await repo.transfers.findById("t-0001")).payloadMeta.totalChunks, 3);
  });

  it("progress + history stores round-trip", async () => {
    await repo.progress.save("t-0001", { progress: 0.5 });
    assert.equal((await repo.progress.get("t-0001")).progress, 0.5);
    await repo.history.record({ transferId: "t-0001", conversationId: "c", state: "completed", at: new Date(1).toISOString() });
    assert.equal((await repo.history.listByConversation("c")).length, 1);
  });
});
