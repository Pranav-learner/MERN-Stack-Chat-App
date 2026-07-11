/**
 * Validation + serialization (Layer 8, Sprint 1). Enforces the framework's core invariant: NO
 * plaintext / key material anywhere in a record, wire envelope, ACK, or DTO — and that public DTOs
 * exclude the ciphertext by default. DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cipher } from "./helpers.js";
import {
  validateSendRequest,
  validateWireEnvelope,
  validateMessageId,
  validateSequence,
  validateEncryptedPayload,
  assertNoPlaintext,
  assertSender,
  requireMessage,
  validateRepository,
  FORBIDDEN_KEYS,
} from "../validators/validators.js";
import { toPublicMessage, toDeliveryStatus, toMessageListItem } from "../serializers/serializer.js";
import { createMessage } from "../delivery/message.js";
import { buildDataEnvelope, buildAckEnvelope } from "../transport/wire.js";
import { DeliveryState } from "../types/types.js";

describe("validators", () => {
  it("accepts a well-formed send request", () => {
    assert.ok(validateSendRequest({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", encryptedPayload: cipher() }));
  });

  it("rejects malformed identifiers, priorities, and TTLs", () => {
    assert.throws(() => validateSendRequest({ conversationId: "", senderDeviceId: "a", receiverDeviceId: "b", encryptedPayload: cipher() }), /conversation/);
    assert.throws(() => validateSendRequest({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", encryptedPayload: cipher(), priority: "urgent" }), /priority/);
    assert.throws(() => validateSendRequest({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", encryptedPayload: cipher(), ttlMs: -1 }), /ttlMs/);
  });

  it("requires a present, non-plaintext encrypted payload", () => {
    assert.throws(() => validateEncryptedPayload(null), /required/);
    assert.throws(() => validateEncryptedPayload(42), /object or string/);
    assert.throws(() => validateEncryptedPayload({ plaintext: "hi" }), /plaintext|secret/);
    assert.ok(validateEncryptedPayload(cipher()));
    assert.ok(validateEncryptedPayload("base64ciphertext"));
  });

  it("validateMessageId / validateSequence enforce shape", () => {
    assert.throws(() => validateMessageId("short"), /Invalid message identifier/);
    assert.ok(validateMessageId("msg-000000000001"));
    assert.throws(() => validateSequence(-1), /sequence/);
    assert.throws(() => validateSequence(1.5), /sequence/);
    assert.equal(validateSequence(7), 7);
  });

  it("every forbidden key is rejected by the deep scan", () => {
    for (const key of FORBIDDEN_KEYS) {
      assert.throws(() => assertNoPlaintext({ nested: { [key]: "leak" } }), new RegExp(key), `should reject "${key}"`);
    }
  });

  it("deep scan is cycle-safe", () => {
    const a = { ok: 1 };
    a.self = a;
    assert.doesNotThrow(() => assertNoPlaintext(a));
  });

  it("validateWireEnvelope validates a DATA and an ACK envelope, and rejects plaintext", () => {
    const m = createMessage({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", encryptedPayload: cipher(), sequenceNumber: 1, messageId: "wire-00000001" });
    assert.ok(validateWireEnvelope(buildDataEnvelope(m)));
    assert.ok(validateWireEnvelope(buildAckEnvelope({ messageId: "wire-00000001", conversationId: "c", sender: "b", receiver: "a", seq: 1, ackId: "k1" })));
    const bad = buildDataEnvelope(m);
    bad.payload = { plaintext: "oops" };
    assert.throws(() => validateWireEnvelope(bad), /plaintext|secret/);
  });

  it("assertSender + requireMessage guard ownership + existence", () => {
    const m = { messageId: "x", senderDeviceId: "a" };
    assert.throws(() => assertSender(m, "b"), /not the sender/);
    assert.ok(assertSender(m, "a"));
    assert.throws(() => requireMessage(null, "x"), /not found/);
  });

  it("validateRepository checks the store contract", () => {
    assert.throws(() => validateRepository({ create() {} }), /missing method/);
  });
});

describe("serializers", () => {
  const m = createMessage({ conversationId: "c", senderDeviceId: "a", receiverDeviceId: "b", encryptedPayload: cipher("dto"), sequenceNumber: 3, messageId: "ser-00000001" });
  m.state = DeliveryState.ACKNOWLEDGED;

  it("public DTO excludes the ciphertext by default", () => {
    const dto = toPublicMessage(m);
    assert.equal(dto.encryptedPayload, undefined);
    assert.equal(dto.messageId, "ser-00000001");
    assert.equal(dto.delivered, true);
    assert.equal(dto.terminal, true);
  });

  it("public DTO includes the OPAQUE ciphertext only on explicit request", () => {
    const dto = toPublicMessage(m, { includePayload: true });
    assert.equal(dto.encryptedPayload.ciphertext, cipher("dto").ciphertext);
    assert.equal(dto.encryptedPayload.plaintext, undefined);
  });

  it("delivery-status + list-item views never carry a payload", () => {
    assert.equal(toDeliveryStatus(m).encryptedPayload, undefined);
    assert.equal(toMessageListItem(m).encryptedPayload, undefined);
    assert.equal(toDeliveryStatus(m).state, DeliveryState.ACKNOWLEDGED);
  });
});
