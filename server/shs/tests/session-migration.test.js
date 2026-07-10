import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSession, isResumable, isParty, roleOf, isSessionActive, isSessionTerminal } from "../sessions/session.js";
import { HandshakeState } from "../types.js";
import { SHS_SCHEMA_VERSION, handshakeReport, sweepStaleSessions } from "../migration/migration.js";
import { makeManager, startAB, makeClock, makeIdGen } from "./helpers.js";

describe("session model helpers", () => {
  const mk = (over = {}) =>
    createSession({
      initiator: "alice",
      responder: "bob",
      initiatorDevice: "dev-a",
      ttlMs: 1000,
      clock: makeClock(1000),
      idGenerator: makeIdGen(),
      ...over,
    });

  it("creates a CREATED session with sane defaults", () => {
    const s = mk();
    assert.equal(s.state, HandshakeState.CREATED);
    assert.equal(s.initiator, "alice");
    assert.equal(s.retryCount, 0);
    assert.equal(s.negotiatedCapabilities.length, 0);
    assert.equal(s.history.length, 1);
    assert.equal(new Date(s.expiresAt).getTime() - new Date(s.createdAt).getTime(), 1000);
  });

  it("party + role helpers", () => {
    const s = mk();
    assert.equal(isParty(s, "alice"), true);
    assert.equal(isParty(s, "carol"), false);
    assert.equal(roleOf(s, "alice"), "initiator");
    assert.equal(roleOf(s, "bob"), "responder");
    assert.equal(roleOf(s, "carol"), null);
  });

  it("active/terminal/resumable checks", () => {
    const s = mk();
    assert.equal(isSessionActive(s), true);
    assert.equal(isSessionTerminal(s), false);
    assert.equal(isResumable(s, 1500), true);
    assert.equal(isResumable(s, 3000), false); // past expiry (created@1000 + 1000)
    s.state = HandshakeState.COMPLETED;
    assert.equal(isSessionTerminal(s), true);
    assert.equal(isResumable(s, 1500), false); // terminal
  });
});

describe("migration / reporting", () => {
  it("exposes a schema version", () => {
    assert.equal(typeof SHS_SCHEMA_VERSION, "number");
  });

  it("handshakeReport groups a user's sessions by state", async () => {
    const { manager } = makeManager();
    const a = await startAB(manager);
    await manager.acceptHandshake(a.session.handshakeId, "bob", {});
    await manager.startHandshake({ initiator: "alice", responder: "carol", initiatorDevice: "dev-a" });

    const report = await handshakeReport({ handshakeManager: manager, userId: "alice" });
    assert.equal(report.total, 2);
    assert.equal(report.active, 2);
    assert.equal(report.byState[HandshakeState.NEGOTIATING], 1);
    assert.equal(report.byState[HandshakeState.WAITING], 1);
  });

  it("sweepStaleSessions delegates to the manager", async () => {
    const { manager, clock } = makeManager({ ttlMs: 1000 });
    await startAB(manager);
    clock.advance(2000);
    const result = await sweepStaleSessions({ handshakeManager: manager });
    assert.equal(result.expired, 1);
  });
});
