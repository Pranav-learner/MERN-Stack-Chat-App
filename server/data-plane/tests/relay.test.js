/**
 * The server-side blind relay (store-and-forward): relay → inbox pull → ACK, ownership guards, the
 * no-plaintext invariant, and delivery diagnostics. DB-free (in-memory repository). Layer 8, Sprint 1.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeIdGen, cipher } from "./helpers.js";
import { createDataPlaneRelayService } from "../api/relayService.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import { DeliveryState } from "../types/types.js";

describe("DataPlaneRelayService", () => {
  let relay, repo;
  beforeEach(() => {
    repo = createInMemoryMessageRepository();
    relay = createDataPlaneRelayService({ repository: repo, clock: makeClock().now, idGenerator: makeIdGen() });
  });

  it("relays an encrypted message and holds it SENT for the receiver", async () => {
    const dto = await relay.relay({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: cipher("hi") });
    assert.equal(dto.state, DeliveryState.SENT);
    assert.equal(dto.encryptedPayload, undefined, "relay DTO carries no payload");
    assert.equal(dto.sequenceNumber, 1);
  });

  it("delivers the ciphertext to the receiver on inbox pull and advances to DELIVERED", async () => {
    const { messageId } = await relay.relay({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: cipher("payload") });
    const inbox = await relay.inbox({ actingDevice: "bob", conversationId: "c1" });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].messageId, messageId);
    assert.equal(inbox[0].encryptedPayload.ciphertext, cipher("payload").ciphertext, "receiver gets the opaque ciphertext");
    assert.equal((await relay.getStatus({ actingDevice: "alice", messageId })).state, DeliveryState.DELIVERED);
    // A second pull returns nothing (already delivered).
    assert.equal((await relay.inbox({ actingDevice: "bob", conversationId: "c1" })).length, 0);
  });

  it("lets only the receiver acknowledge, driving the message to ACKNOWLEDGED", async () => {
    const { messageId } = await relay.relay({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: cipher() });
    await relay.inbox({ actingDevice: "bob", conversationId: "c1" });
    await assert.rejects(() => relay.acknowledge({ actingDevice: "mallory", messageId }), /receiver/);
    const acked = await relay.acknowledge({ actingDevice: "bob", messageId });
    assert.equal(acked.state, DeliveryState.ACKNOWLEDGED);
    // Idempotent.
    assert.equal((await relay.acknowledge({ actingDevice: "bob", messageId })).state, DeliveryState.ACKNOWLEDGED);
  });

  it("guards sender-only status reads", async () => {
    const { messageId } = await relay.relay({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: cipher() });
    await assert.rejects(() => relay.getStatus({ actingDevice: "bob", messageId }), /not the sender/);
  });

  it("rejects a relay carrying a plaintext-looking payload", async () => {
    await assert.rejects(
      () => relay.relay({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: { plaintext: "leak" } }),
      /plaintext|ciphertext/i,
    );
  });

  it("reports diagnostics (blind: canDecrypt=false) and pending", async () => {
    await relay.relay({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: cipher(1) });
    await relay.relay({ actingDevice: "alice", conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: cipher(2) });
    const pending = await relay.getPending({ actingDevice: "alice", conversationId: "c1" });
    assert.equal(pending.length, 2);
    const diag = await relay.getDiagnostics({ conversationId: "c1" });
    assert.equal(diag.total, 2);
    assert.equal(diag.canDecrypt, false);
    assert.equal(diag.byState[DeliveryState.SENT], 2);
  });
});
