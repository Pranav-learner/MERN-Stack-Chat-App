/**
 * Delivery lifecycle FSM + the in-memory repository contract (Layer 8, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { cipher } from "./helpers.js";
import { createMessage } from "../delivery/message.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import {
  canDeliveryTransition,
  assertDeliveryTransition,
  nextDeliveryStates,
  DeliveryLifecycle,
} from "../lifecycle/lifecycle.js";
import { DeliveryState, isTerminalDeliveryState } from "../types/types.js";

describe("delivery FSM", () => {
  it("permits the happy-path walk", () => {
    assert.ok(canDeliveryTransition(DeliveryState.CREATED, DeliveryState.QUEUED));
    assert.ok(canDeliveryTransition(DeliveryState.QUEUED, DeliveryState.SENDING));
    assert.ok(canDeliveryTransition(DeliveryState.SENDING, DeliveryState.SENT));
    assert.ok(canDeliveryTransition(DeliveryState.SENT, DeliveryState.ACKNOWLEDGED));
    assert.ok(canDeliveryTransition(DeliveryState.ACKNOWLEDGED, DeliveryState.DESTROYED));
  });

  it("permits retransmit + requeue loops", () => {
    assert.ok(canDeliveryTransition(DeliveryState.SENT, DeliveryState.SENDING));
    assert.ok(canDeliveryTransition(DeliveryState.SENDING, DeliveryState.QUEUED));
    assert.ok(canDeliveryTransition(DeliveryState.SENT, DeliveryState.QUEUED));
  });

  it("permits an ACK arriving while still SENDING (fast loopback)", () => {
    assert.ok(canDeliveryTransition(DeliveryState.SENDING, DeliveryState.ACKNOWLEDGED));
  });

  it("rejects illegal transitions", () => {
    assert.equal(canDeliveryTransition(DeliveryState.CREATED, DeliveryState.SENT), false);
    assert.equal(canDeliveryTransition(DeliveryState.ACKNOWLEDGED, DeliveryState.SENDING), false);
    assert.equal(canDeliveryTransition(DeliveryState.DESTROYED, DeliveryState.QUEUED), false);
    assert.throws(() => assertDeliveryTransition(DeliveryState.CREATED, DeliveryState.SENT), /Cannot transition/);
    assert.throws(() => assertDeliveryTransition(DeliveryState.CREATED, "bogus"), /Unknown delivery state/);
  });

  it("treats a self-transition as legal (idempotent)", () => {
    assert.ok(canDeliveryTransition(DeliveryState.SENT, DeliveryState.SENT));
  });

  it("marks terminal states and exposes reachable next states", () => {
    assert.ok(isTerminalDeliveryState(DeliveryState.FAILED));
    assert.equal(isTerminalDeliveryState(DeliveryState.SENT), false);
    assert.deepEqual(nextDeliveryStates(DeliveryState.DESTROYED), []);
  });

  it("DeliveryLifecycle records transition history", () => {
    const fsm = new DeliveryLifecycle();
    fsm.transition(DeliveryState.QUEUED);
    fsm.transition(DeliveryState.SENDING, { reason: "flush" });
    fsm.transition(DeliveryState.SENT);
    assert.equal(fsm.state, DeliveryState.SENT);
    assert.equal(fsm.history.length, 3);
    assert.equal(fsm.history[1].reason, "flush");
  });
});

describe("in-memory repository contract", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryMessageRepository();
  });

  // NOTE: createMessage always produces a CREATED-state record; overrides for state/nextRetryAt/
  // expiresAt are applied on top of it (they are not factory params).
  const mk = (over = {}) => ({ ...createMessage({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", encryptedPayload: cipher(), sequenceNumber: 1, messageId: "seed-00000001", connectionId: over.connectionId }), ...over });

  it("create / findById / update / delete round-trip", async () => {
    const m = mk();
    await repo.messages.create(m);
    assert.equal((await repo.messages.findById(m.messageId)).messageId, m.messageId);
    const upd = await repo.messages.update(m.messageId, { state: DeliveryState.QUEUED });
    assert.equal(upd.state, DeliveryState.QUEUED);
    assert.equal(await repo.messages.delete(m.messageId), true);
    assert.equal(await repo.messages.findById(m.messageId), null);
  });

  it("update on a missing message throws MessageNotFound", async () => {
    await assert.rejects(() => repo.messages.update("nope-00000001", { state: DeliveryState.QUEUED }), /not found/i);
  });

  it("nextSequence is monotonic per (conversation, sender) stream", async () => {
    assert.equal(await repo.messages.nextSequence("c", "a"), 1);
    assert.equal(await repo.messages.nextSequence("c", "a"), 2);
    assert.equal(await repo.messages.nextSequence("c", "z"), 1, "different sender → own stream");
    assert.equal(await repo.messages.nextSequence("c2", "a"), 1, "different conversation → own stream");
  });

  it("listPendingByConnection filters active messages by connection", async () => {
    await repo.messages.create(mk({ messageId: "act-00000001", state: DeliveryState.SENT, connectionId: "conn-1" }));
    await repo.messages.create(mk({ messageId: "act-00000002", state: DeliveryState.ACKNOWLEDGED, connectionId: "conn-1" }));
    await repo.messages.create(mk({ messageId: "act-00000003", state: DeliveryState.QUEUED, connectionId: "conn-2" }));
    assert.equal((await repo.messages.listPendingByConnection("conn-1")).length, 1);
    assert.equal((await repo.messages.listPendingByConnection()).length, 2, "no filter → all active");
  });

  it("listRetryDue returns retryable messages past their deadline", async () => {
    await repo.messages.create(mk({ messageId: "rd-00000001", state: DeliveryState.SENT, nextRetryAt: "2024-01-01T00:00:00.000Z" }));
    await repo.messages.create(mk({ messageId: "rd-00000002", state: DeliveryState.SENT, nextRetryAt: "2999-01-01T00:00:00.000Z" }));
    const due = await repo.messages.listRetryDue("2024-06-01T00:00:00.000Z");
    assert.deepEqual(due.map((d) => d.messageId), ["rd-00000001"]);
  });

  it("listExpired returns active messages past their TTL", async () => {
    await repo.messages.create(mk({ messageId: "ex-00000001", state: DeliveryState.SENT, expiresAt: "2024-01-01T00:00:00.000Z" }));
    const expired = await repo.messages.listExpired("2024-06-01T00:00:00.000Z");
    assert.deepEqual(expired.map((d) => d.messageId), ["ex-00000001"]);
  });

  it("countByState aggregates", async () => {
    await repo.messages.create(mk({ messageId: "cs-00000001", state: DeliveryState.SENT }));
    await repo.messages.create(mk({ messageId: "cs-00000002", state: DeliveryState.SENT }));
    await repo.messages.create(mk({ messageId: "cs-00000003", state: DeliveryState.ACKNOWLEDGED }));
    assert.deepEqual(await repo.messages.countByState(), { sent: 2, acknowledged: 1 });
  });

  it("inbound + ackHistory + ordering stores round-trip", async () => {
    await repo.inbound.record({ messageId: "in-00000001", conversationId: "c", sequenceNumber: 1 });
    assert.equal((await repo.inbound.listByConversation("c")).length, 1);
    await repo.ackHistory.record({ ackId: "k1", messageId: "in-00000001", conversationId: "c", at: "2024-01-01T00:00:00.000Z" });
    assert.equal((await repo.ackHistory.listByMessage("in-00000001")).length, 1);
    await repo.ordering.saveMetadata("c", { expected: 5, buffered: [] });
    assert.equal((await repo.ordering.getMetadata("c")).expected, 5);
  });

  it("stores + returns records by deep copy (mutation isolation)", async () => {
    const m = mk({ messageId: "iso-00000001" });
    await repo.messages.create(m);
    m.encryptedPayload.ciphertext = "TAMPERED";
    const fetched = await repo.messages.findById("iso-00000001");
    assert.notEqual(fetched.encryptedPayload.ciphertext, "TAMPERED");
  });
});
