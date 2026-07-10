import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySessionRepository } from "../repository/inMemoryRepository.js";
import { createSecureSession } from "../model/secureSession.js";
import { toPublicSession } from "../serialization/sessionSerializer.js";
import { SessionEventBus } from "../events/events.js";
import { SessionState, SessionEventType } from "../types.js";
import {
  validateSessionId,
  validateMetadata,
  assertNoDuplicate,
  assertParticipant,
  assertParticipantsMatch,
  validateRepository,
  requireSession,
} from "../validators/validators.js";
import {
  SessionValidationError,
  SessionNotFoundError,
  DuplicateSessionError,
  ParticipantMismatchError,
  CorruptedMetadataError,
} from "../errors.js";
import { makeClock } from "./helpers.js";

const record = (over = {}) =>
  createSecureSession({
    handshakeId: "hs-1",
    participants: ["alice", "bob"],
    encryptionKeyMeta: { algorithm: "aes-256-gcm", length: 32, keyId: "k1", fingerprint: "fp" },
    authenticationKeyMeta: { algorithm: "hmac-sha256", length: 32 },
    clock: makeClock(),
    idGenerator: () => over.sessionId ?? "sess-abcdefgh",
    ...over,
  });

describe("in-memory session repository", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemorySessionRepository();
  });

  it("create / findById / update / delete", async () => {
    const s = record();
    await repo.sessions.create(s);
    assert.equal((await repo.sessions.findById(s.sessionId)).handshakeId, "hs-1");
    const up = await repo.sessions.update(s.sessionId, { status: SessionState.ACTIVE });
    assert.equal(up.status, SessionState.ACTIVE);
    assert.equal(await repo.sessions.delete(s.sessionId), true);
    assert.equal(await repo.sessions.findById(s.sessionId), null);
    await assert.rejects(() => repo.sessions.update("missing", {}), SessionNotFoundError);
  });

  it("stores deep copies", async () => {
    const s = record();
    await repo.sessions.create(s);
    s.metadata.x = 1;
    assert.equal((await repo.sessions.findById(s.sessionId)).metadata.x, undefined);
  });

  it("findActiveByHandshake ignores terminal; listByUser; findByState", async () => {
    const a = record({ sessionId: "sess-aaaaaaaa" });
    await repo.sessions.create({ ...a, status: SessionState.ACTIVE });
    assert.equal((await repo.sessions.findActiveByHandshake("hs-1")).sessionId, "sess-aaaaaaaa");
    await repo.sessions.update("sess-aaaaaaaa", { status: SessionState.CLOSED });
    assert.equal(await repo.sessions.findActiveByHandshake("hs-1"), null);
    assert.equal((await repo.sessions.listByUser("alice")).length, 1);
    assert.equal((await repo.sessions.listByUser("zoe")).length, 0);
    assert.equal((await repo.sessions.findByState(SessionState.CLOSED)).length, 1);
  });
});

describe("validators", () => {
  it("session id shape", () => {
    assert.doesNotThrow(() => validateSessionId("abcdefgh"));
    assert.throws(() => validateSessionId("short"), SessionValidationError);
    assert.throws(() => validateSessionId(123), SessionValidationError);
  });

  it("requireSession", () => {
    assert.throws(() => requireSession(null, "x"), SessionNotFoundError);
    assert.equal(requireSession({ sessionId: "x" }, "x").sessionId, "x");
  });

  it("metadata validation detects corruption + rejects raw key material", () => {
    assert.doesNotThrow(() => validateMetadata(record()));
    assert.throws(() => validateMetadata({ ...record(), status: "bogus" }), CorruptedMetadataError);
    assert.throws(() => validateMetadata({ ...record(), participants: [] }), CorruptedMetadataError);
    const leaky = record();
    leaky.encryptionKey.bytes = Buffer.alloc(32);
    assert.throws(() => validateMetadata(leaky), CorruptedMetadataError);
    const withSecret = { ...record(), sharedSecret: "oops" };
    assert.throws(() => validateMetadata(withSecret), CorruptedMetadataError);
  });

  it("duplicate + participant guards", () => {
    assert.throws(() => assertNoDuplicate({ sessionId: "x", handshakeId: "h" }), DuplicateSessionError);
    assert.doesNotThrow(() => assertNoDuplicate(null));
    assert.doesNotThrow(() => assertParticipant(record(), "alice"));
    assert.throws(() => assertParticipant(record(), "carol"), ParticipantMismatchError);
    assert.doesNotThrow(() => assertParticipantsMatch(["a", "b"], ["b", "a"]));
    assert.throws(() => assertParticipantsMatch(["a", "b"], ["a", "c"]), ParticipantMismatchError);
  });

  it("repository contract validation (malformed repo)", () => {
    assert.throws(() => validateRepository({}), SessionValidationError);
    assert.throws(() => validateRepository({ create() {} }), SessionValidationError);
    assert.throws(() => validateRepository(null), SessionValidationError);
  });
});

describe("serializer (secret-stripping) + events", () => {
  it("DTO exposes key METADATA only, never bytes", () => {
    const dto = toPublicSession(record(), { now: 1000 });
    assert.equal(dto.encryptionKey.keyId, "k1");
    assert.equal(dto.encryptionKey.algorithm, "aes-256-gcm");
    assert.equal("bytes" in dto.encryptionKey, false);
    assert.equal(JSON.stringify(dto).includes("sharedSecret"), false);
    assert.equal(dto.status, "created");
    assert.equal(dto.isActive, true); // CREATED is in the active family
    assert.equal(dto.isExpired, false);
  });

  it("event bus typed + wildcard, unsubscribe", () => {
    const bus = new SessionEventBus();
    const specific = [];
    const all = [];
    const off = bus.on(SessionEventType.CREATED, (e) => specific.push(e));
    bus.on("*", (e) => all.push(e));
    bus.emit(SessionEventType.CREATED, { sessionId: "s" });
    off();
    bus.emit(SessionEventType.CREATED, { sessionId: "s" });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 2);
    assert.ok(typeof all[0].at === "number");
  });
});
