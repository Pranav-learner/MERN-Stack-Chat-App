import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SessionContextRepository } from "../repositories/sessionContextRepository.js";
import { SessionIntegrationEventBus } from "../events/events.js";
import { IntegrationEventType, TransportMode } from "../types.js";
import { pairKey } from "../validators/sessionValidators.js";
import { makeStack, establishBetween, fakeReq, fakeRes, runMiddleware } from "./helpers.js";

describe("session middleware", () => {
  let stack;
  beforeEach(() => {
    stack = makeStack();
  });

  it("resolveSession attaches a context and never blocks (permissive)", async () => {
    const { resolveSession, requireSession } = stack.middleware;
    const req = fakeReq("alice", { id: "bob" });
    const res = fakeRes();
    const r1 = await runMiddleware(resolveSession, req, res);
    assert.equal(r1.nexted, true);
    assert.ok(req.sessionContext);
    assert.equal(req.sessionContext.transportMode, TransportMode.FALLBACK);
    // permissive requireSession passes through
    const r2 = await runMiddleware(requireSession, req, res);
    assert.equal(r2.nexted, true);
  });

  it("attaches a session-backed context when a session exists", async () => {
    await establishBetween(stack.appSessions, "alice", "bob");
    const req = fakeReq("alice", { id: "bob" });
    await runMiddleware(stack.middleware.resolveSession, req, fakeRes());
    assert.equal(req.sessionContext.resolved, true);
    assert.equal(req.sessionContext.transportMode, TransportMode.SESSION);
  });

  it("STRICT requireSession rejects a session-less request with 428", async () => {
    const strict = makeStack({ enforcement: "strict" });
    const req = fakeReq("alice", { id: "bob" });
    const res = fakeRes();
    await runMiddleware(strict.middleware.resolveSession, req, res);
    const r = await runMiddleware(strict.middleware.requireSession, req, res);
    assert.equal(r.nexted, false);
    assert.equal(res.statusCode, 428);
    assert.equal(res.body.code, "ERR_MSG_SESSION_HANDSHAKE_REQUIRED");
  });

  it("refreshSession touches an active session without blocking", async () => {
    const { session } = await establishBetween(stack.appSessions, "alice", "bob");
    const req = fakeReq("alice", { id: "bob" });
    await runMiddleware(stack.middleware.resolveSession, req, fakeRes());
    const before = (await stack.secure.getSession(session.sessionId)).lastActivityAt;
    stack.clock.advance(1000);
    const r = await runMiddleware(stack.middleware.refreshSession, req, fakeRes());
    assert.equal(r.nexted, true);
    await new Promise((res) => setImmediate(res)); // let the best-effort touch settle
    const after = (await stack.secure.getSession(session.sessionId)).lastActivityAt;
    assert.notEqual(before, after);
  });
});

describe("SessionContextRepository", () => {
  let stack;
  let repo;
  beforeEach(() => {
    stack = makeStack();
    repo = new SessionContextRepository({ sessions: stack.secure, clock: stack.clock });
  });

  it("finds the active session for a pair + caches it", async () => {
    await establishBetween(stack.appSessions, "alice", "bob");
    const first = await repo.findActiveByPair("alice", "bob");
    assert.ok(first);
    const second = await repo.findActiveByPair("bob", "alice"); // order-independent + cached
    assert.equal(second.sessionId, first.sessionId);
    const stats = repo.stats();
    assert.ok(stats.cacheHits >= 1);
    assert.equal(stats.resolved >= 1, true);
  });

  it("returns null (missing) when there is no session", async () => {
    assert.equal(await repo.findActiveByPair("x", "y"), null);
    assert.equal(repo.stats().missing >= 1, true);
  });

  it("invalidation clears the cached pair", async () => {
    await establishBetween(stack.appSessions, "alice", "bob");
    await repo.findActiveByPair("alice", "bob");
    repo.invalidatePair("alice", "bob");
    assert.equal(repo.stats().invalidations, 1);
    assert.equal(repo.stats().cacheSize, 0);
  });

  it("pairKey is order-independent", () => {
    assert.equal(pairKey("a", "b"), pairKey("b", "a"));
  });
});

describe("integration event bus", () => {
  it("delivers typed + wildcard events; unsubscribe works", () => {
    const bus = new SessionIntegrationEventBus();
    const specific = [];
    const all = [];
    const off = bus.on(IntegrationEventType.SESSION_RESOLVED, (e) => specific.push(e));
    bus.on("*", (e) => all.push(e));
    bus.emit(IntegrationEventType.SESSION_RESOLVED, { sessionId: "s" });
    off();
    bus.emit(IntegrationEventType.SESSION_RESOLVED, { sessionId: "s" });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 2);
    assert.ok(typeof all[0].at === "number");
  });
});
