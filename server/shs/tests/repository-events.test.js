import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryShsRepository } from "../repository/inMemoryRepository.js";
import { createSession } from "../sessions/session.js";
import { HandshakeEventBus } from "../events/events.js";
import { HandshakeState, HandshakeEventType } from "../types.js";
import { HandshakeNotFoundError } from "../errors.js";
import { makeClock, makeIdGen } from "./helpers.js";

describe("in-memory repository", () => {
  let repo;
  let clock;
  let idGen;
  const mk = (over = {}) =>
    createSession({ initiator: "alice", responder: "bob", initiatorDevice: "dev-a", clock, idGenerator: idGen, ...over });

  beforeEach(() => {
    repo = createInMemoryShsRepository();
    clock = makeClock();
    idGen = makeIdGen();
  });

  it("create / findById / update / delete", async () => {
    const s = mk();
    await repo.sessions.create(s);
    assert.equal((await repo.sessions.findById(s.handshakeId)).initiator, "alice");
    const updated = await repo.sessions.update(s.handshakeId, { state: HandshakeState.WAITING });
    assert.equal(updated.state, HandshakeState.WAITING);
    assert.equal(await repo.sessions.delete(s.handshakeId), true);
    assert.equal(await repo.sessions.findById(s.handshakeId), null);
  });

  it("update on a missing id throws", async () => {
    await assert.rejects(() => repo.sessions.update("nope", {}), HandshakeNotFoundError);
  });

  it("stores deep copies (no reference leakage)", async () => {
    const s = mk();
    await repo.sessions.create(s);
    s.metadata.mutated = true;
    const loaded = await repo.sessions.findById(s.handshakeId);
    assert.equal(loaded.metadata.mutated, undefined);
  });

  it("findActiveByPair ignores terminal sessions", async () => {
    const a = mk();
    await repo.sessions.create(a);
    assert.equal((await repo.sessions.findActiveByPair("alice", "bob")).handshakeId, a.handshakeId);
    await repo.sessions.update(a.handshakeId, { state: HandshakeState.COMPLETED });
    assert.equal(await repo.sessions.findActiveByPair("alice", "bob"), null);
  });

  it("listByUser matches initiator OR responder; findByState filters", async () => {
    await repo.sessions.create(mk());
    await repo.sessions.create(mk({ initiator: "carol", responder: "alice" }));
    assert.equal((await repo.sessions.listByUser("alice")).length, 2);
    assert.equal((await repo.sessions.listByUser("carol")).length, 1);
    assert.equal((await repo.sessions.listByUser("dave")).length, 0);

    const all = await repo.sessions.listAll();
    await repo.sessions.update(all[0].handshakeId, { state: HandshakeState.WAITING });
    assert.equal((await repo.sessions.findByState(HandshakeState.WAITING)).length, 1);
  });

  it("reset clears everything", async () => {
    await repo.sessions.create(mk());
    repo.reset();
    assert.equal((await repo.sessions.listAll()).length, 0);
  });
});

describe("event bus", () => {
  it("delivers typed events and the wildcard", () => {
    const bus = new HandshakeEventBus();
    const specific = [];
    const all = [];
    bus.on(HandshakeEventType.STARTED, (e) => specific.push(e));
    bus.on("*", (e) => all.push(e));
    bus.emit(HandshakeEventType.STARTED, { handshakeId: "hs-1" });
    bus.emit(HandshakeEventType.COMPLETED, { handshakeId: "hs-1" });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 2);
    assert.ok(typeof all[0].at === "number");
    assert.equal(all[0].type, HandshakeEventType.STARTED);
  });

  it("unsubscribe stops delivery; once fires a single time", () => {
    const bus = new HandshakeEventBus();
    let count = 0;
    const off = bus.on(HandshakeEventType.STARTED, () => count++);
    bus.emit(HandshakeEventType.STARTED, { handshakeId: "x" });
    off();
    bus.emit(HandshakeEventType.STARTED, { handshakeId: "x" });
    assert.equal(count, 1);

    let onceCount = 0;
    bus.once(HandshakeEventType.COMPLETED, () => onceCount++);
    bus.emit(HandshakeEventType.COMPLETED, { handshakeId: "x" });
    bus.emit(HandshakeEventType.COMPLETED, { handshakeId: "x" });
    assert.equal(onceCount, 1);
  });
});
