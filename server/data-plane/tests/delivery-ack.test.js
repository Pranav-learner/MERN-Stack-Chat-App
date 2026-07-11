/**
 * Reliable delivery + the ACK protocol (Layer 8, Sprint 1). Covers: send → deliver → ACK round-trip,
 * delivery tracking, ACK generation/receipt, duplicate-ACK handling, delivery state transitions,
 * cancellation, and the no-plaintext invariant. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, cipher, countEvents, makeClock, makeIdGen } from "./helpers.js";
import { MessagingEngine } from "../manager/messagingEngine.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import { DeliveryState, MessagingEventType } from "../types/types.js";

describe("reliable delivery + ACK", () => {
  let mesh;
  beforeEach(() => {
    mesh = makeMesh();
  });

  it("delivers an encrypted message and drives it to ACKNOWLEDGED", async () => {
    const { engines, delivered } = mesh;
    const { message } = await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher("hi") });

    assert.equal(delivered.b.length, 1);
    assert.equal(delivered.b[0].encryptedPayload.ciphertext, cipher("hi").ciphertext);
    const status = await engines.a.getStatus(message.messageId);
    assert.equal(status.state, DeliveryState.ACKNOWLEDGED);
    assert.equal(status.delivered, true);
    assert.equal(status.terminal, true);
  });

  it("hands the OPAQUE ciphertext to the app via onMessage, never a plaintext field", async () => {
    const { engines, delivered } = mesh;
    await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher("secret") });
    const d = delivered.b[0];
    assert.ok(d.encryptedPayload.ciphertext);
    assert.equal(d.encryptedPayload.plaintext, undefined);
    assert.equal(d.sender, "a");
    assert.equal(d.seq, 1);
  });

  it("emits queued + acknowledged events on the sender and delivered + ack_sent on the receiver", async () => {
    const { engines, events } = mesh;
    await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher() });
    assert.equal(countEvents(events.a, MessagingEventType.MESSAGE_QUEUED), 1);
    assert.equal(countEvents(events.a, MessagingEventType.ACK_RECEIVED), 1);
    assert.equal(countEvents(events.a, MessagingEventType.MESSAGE_ACKNOWLEDGED), 1);
    assert.equal(countEvents(events.b, MessagingEventType.MESSAGE_DELIVERED), 1);
    assert.equal(countEvents(events.b, MessagingEventType.ACK_SENT), 1);
  });

  it("records ack history on both sides (sent + received)", async () => {
    const { engines } = mesh;
    const { message } = await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher() });
    const senderAcks = await engines.a.ackHistory.listByMessage(message.messageId);
    const receiverAcks = await engines.b.ackHistory.listByMessage(message.messageId);
    assert.equal(senderAcks.filter((a) => a.direction === "received").length, 1);
    assert.equal(receiverAcks.filter((a) => a.direction === "sent").length, 1);
  });

  it("assigns per-(conversation, sender) monotonic sequence numbers", async () => {
    const { engines } = mesh;
    const r1 = await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher(1) });
    const r2 = await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher(2) });
    const r3 = await engines.a.send({ conversationId: "c2", receiverDeviceId: "b", encryptedPayload: cipher(3) });
    assert.equal(r1.message.sequenceNumber, 1);
    assert.equal(r2.message.sequenceNumber, 2);
    assert.equal(r3.message.sequenceNumber, 1, "a new conversation restarts the sequence");
  });

  it("re-ACKs a duplicate DATA envelope without re-delivering it", async () => {
    const { engines, delivered } = mesh;
    const { message } = await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher("x") });
    const replay = { type: "data", protocol: "1.0", messageId: message.messageId, conversationId: "c1", sender: "a", receiver: "b", connectionId: null, seq: 1, payload: cipher("x"), retry: 1, ts: "2024-01-01T00:00:00.000Z" };
    const result = await engines.b.receive(replay);
    assert.equal(result.outcome, "duplicate");
    assert.equal(delivered.b.length, 1, "still exactly one delivery");
  });

  it("ignores a duplicate ACK (idempotent acknowledgement)", async () => {
    const { engines } = mesh;
    const { message } = await engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher() });
    // Re-inject an ACK for the already-acknowledged message.
    const ackEnv = { type: "ack", protocol: "1.0", messageId: message.messageId, conversationId: "c1", sender: "b", receiver: "a", connectionId: null, ack: { ackType: "ack", messageId: message.messageId, seq: 1, ackId: "dup-ack-id-1" }, ts: "2024-01-01T00:00:00.000Z" };
    const r = await engines.a.receive(ackEnv);
    assert.equal(r.outcome, "duplicate");
    const status = await engines.a.getStatus(message.messageId);
    assert.equal(status.state, DeliveryState.ACKNOWLEDGED);
  });

  it("cancels a queued (un-transmitted) message and refuses to cancel a terminal one", async () => {
    // A transport with no live link: the message can't leave, so it stays QUEUED and is cancellable.
    const repo = createInMemoryMessageRepository();
    const offline = { send: async () => { const e = new Error("down"); e.code = "ERR_DATAPLANE_NO_CONNECTION"; throw e; } };
    const engine = new MessagingEngine({ deviceId: "a", ...bundle(repo), transport: offline, clock: makeClock().now, idGenerator: makeIdGen() });
    const { message } = await engine.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher() });
    assert.equal((await engine.getStatus(message.messageId)).state, DeliveryState.QUEUED);

    const cancelled = await engine.cancel(message.messageId);
    assert.equal(cancelled.state, DeliveryState.CANCELLED);

    // Cancelling a terminal message is rejected.
    await assert.rejects(() => engine.cancel(message.messageId), /Cannot cancel/);
  });

  it("rejects a send with a plaintext-looking payload field", async () => {
    const { engines } = mesh;
    await assert.rejects(
      () => engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: { plaintext: "hello world" } }),
      /plaintext|ciphertext/i,
    );
  });

  it("rejects a send whose actingDevice is not this engine's device", async () => {
    const { engines } = mesh;
    await assert.rejects(
      () => engines.a.send({ conversationId: "c1", receiverDeviceId: "b", encryptedPayload: cipher(), actingDevice: "someone-else" }),
      /actingDevice/,
    );
  });
});

function bundle(repo) {
  return { messages: repo.messages, inbound: repo.inbound, ackHistory: repo.ackHistory, ordering: repo.ordering };
}
