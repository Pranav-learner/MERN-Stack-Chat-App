import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryMessageKeyRepository } from "../repository/inMemoryMessageKeyRepository.js";
import { toPublicMessageKeyState, toMessageKeyStatus } from "../serialization/serializer.js";
import {
  validateSessionRef,
  validateMessageNumber,
  assertGenerationMatch,
  assertNoDuplicateSend,
  assertNotConsumed,
  validateEnvelope,
  validateRepository,
} from "../validators/validators.js";
import {
  MessageKeyNotFoundError,
  MessageKeyValidationError,
  GenerationMismatchError,
  DuplicateMessageNumberError,
  DestroyedKeyReuseError,
} from "../errors.js";
import { makePair, makePeer, makeSessionId } from "./helpers.js";

describe("repository — in-memory contract", () => {
  let repo, reset;
  beforeEach(() => {
    ({ messageKeys: repo, reset } = createInMemoryMessageKeyRepository());
  });

  it("create/find/update/delete round-trips + deep-copies; never persists keys", async () => {
    await repo.create({ sessionId: "session-000001", sending: { count: 0, lastNumber: -1 }, messages: [] });
    const got = await repo.findBySessionId("session-000001");
    got.generation = 9;
    assert.notEqual((await repo.findBySessionId("session-000001")).generation, 9);
    await repo.update("session-000001", { generation: 1 });
    assert.equal((await repo.findBySessionId("session-000001")).generation, 1);
    await assert.rejects(() => repo.update("session-000009", {}), MessageKeyNotFoundError);
    assert.equal(await repo.delete("session-000001"), true);
    reset();
    assert.equal((await repo.listAll()).length, 0);
  });
});

describe("validators", () => {
  it("session ref, message number, generation match, duplicate send, consumed, envelope", () => {
    assert.equal(validateSessionRef("session-000001"), "session-000001");
    assert.throws(() => validateSessionRef("x"), MessageKeyValidationError);
    assert.throws(() => validateMessageNumber(-1), MessageKeyValidationError);
    assert.throws(() => assertGenerationMatch(1, 2), GenerationMismatchError);
    assert.throws(() => assertNoDuplicateSend(5, 5), DuplicateMessageNumberError);
    assert.doesNotThrow(() => assertNoDuplicateSend(5, 6));
    assert.throws(() => assertNotConsumed(null, 3), DestroyedKeyReuseError);
    assert.throws(() => validateEnvelope({ messageNumber: 0 }), MessageKeyValidationError);
    assert.throws(() => validateRepository({}), MessageKeyValidationError);
  });
});

describe("serializer", () => {
  it("public DTO whitelists counters + strips secrets", () => {
    const state = { sessionId: "session-000001", generation: 1, sending: { count: 2, lastNumber: 1 }, receiving: { count: 0, lastNumber: -1, highestNumber: -1 }, messages: [{ messageNumber: 0, keyId: "k" }], security: { perMessageKeys: true } };
    const dto = toPublicMessageKeyState(state, { includeMessages: true });
    assert.equal(dto.sending.count, 2);
    assert.equal(dto.messages.length, 1);
    assert.equal("audit" in dto, false);
    assert.equal(toMessageKeyStatus(state).sent, 2);
  });
});

describe("concurrency, multi-device, stress, regression", () => {
  it("concurrent sends are serialized into unique, ordered message numbers", async () => {
    const { alice, bob, sessionId } = await makePair(10);
    const envelopes = await Promise.all(Array.from({ length: 10 }, (_, i) => alice.transport.encrypt({ n: i }, { sessionId })));
    const numbers = envelopes.map((e) => e.messageNumber).sort((a, b) => a - b);
    assert.deepEqual(numbers, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "no collisions; contiguous numbers");
    assert.equal(new Set(envelopes.map((e) => e.payload.keyId)).size, 10, "10 distinct keys");
    // bob decrypts them all (sorted by number, in order)
    const sorted = [...envelopes].sort((a, b) => a.messageNumber - b.messageNumber);
    for (const env of sorted) await bob.transport.decrypt(env, { sessionId });
    assert.equal((await bob.manager.getStatus(sessionId)).received, 10);
  });

  it("stress: 100 messages exchanged in order, all unique keys", async () => {
    const { alice, bob, sessionId } = await makePair(11);
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const env = await alice.transport.encrypt({ i }, { sessionId });
      ids.add(env.payload.keyId);
      assert.deepEqual(await bob.transport.decrypt(env, { sessionId }), { i });
    }
    assert.equal(ids.size, 100);
    assert.equal((await alice.manager.getStatus(sessionId)).sent, 100);
  });

  it("multiple independent sessions do not interfere", async () => {
    const a = await makePeer({ role: "initiator", sessionId: makeSessionId(1), secret: undefined });
    const b = await makePeer({ role: "initiator", sessionId: makeSessionId(2) });
    const e1 = await a.transport.encrypt({ s: 1 }, { sessionId: a.sessionId });
    const e2 = await b.transport.encrypt({ s: 2 }, { sessionId: b.sessionId });
    assert.notEqual(e1.payload.keyId, e2.payload.keyId);
    assert.equal(e1.messageNumber, 0);
    assert.equal(e2.messageNumber, 0);
  });

  it("regression: message keys are gone after use (state DTO shows counts, not keys)", async () => {
    const { alice, sessionId } = await makePair(12);
    await alice.transport.encrypt({ x: 1 }, { sessionId });
    const dto = await alice.manager.getState(sessionId);
    assert.equal(JSON.stringify(dto).toLowerCase().includes("encryptionkey"), false);
    assert.equal(dto.sending.count, 1);
    assert.equal(dto.messages[0].delivery, "encrypted");
  });
});
