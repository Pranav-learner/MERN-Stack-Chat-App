import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SessionResolution, TransportMode, EnforcementMode } from "../types.js";
import { IntegrationEventType } from "../events/events.js";
import { makeStack, establishBetween } from "./helpers.js";

describe("ApplicationSessionManager — resolution + context", () => {
  let stack;
  beforeEach(() => {
    stack = makeStack();
  });

  it("returns a fallback context when no session exists (permissive)", async () => {
    const events = [];
    stack.appSessions.events.on("*", (e) => events.push(e.type));
    const ctx = await stack.appSessions.sessionContext("alice", "bob");
    assert.equal(ctx.resolved, false);
    assert.equal(ctx.transportMode, TransportMode.FALLBACK);
    assert.equal(ctx.resolution, SessionResolution.HANDSHAKE_REQUIRED);
    assert.equal(ctx.fallback, true);
    assert.ok(events.includes(IntegrationEventType.SESSION_MISSING));
  });

  it("resolves + validates an established session", async () => {
    await establishBetween(stack.appSessions, "alice", "bob");
    const ctx = await stack.appSessions.sessionContext("alice", "bob");
    assert.equal(ctx.resolved, true);
    assert.equal(ctx.transportMode, TransportMode.SESSION);
    assert.equal(ctx.resolution, SessionResolution.RESOLVED);
    assert.ok(ctx.keyId);
    assert.equal("encryptionKey" in ctx, false); // metadata only, no key object
  });

  it("is symmetric — either participant resolves the same session", async () => {
    const { session } = await establishBetween(stack.appSessions, "alice", "bob");
    const a = await stack.appSessions.sessionContext("alice", "bob");
    const b = await stack.appSessions.sessionContext("bob", "alice");
    assert.equal(a.sessionId, session.sessionId);
    assert.equal(b.sessionId, session.sessionId);
  });

  it("group messages always take the fallback transport", async () => {
    const ctx = await stack.appSessions.sessionContext("alice", null, { groupId: "g1" });
    assert.equal(ctx.fallback, true);
    assert.equal(ctx.transportMode, TransportMode.FALLBACK);
  });

  it("expired sessions fall back (not resolved)", async () => {
    await establishBetween(stack.appSessions, "alice", "bob");
    assert.equal((await stack.appSessions.sessionContext("alice", "bob")).resolved, true);
    stack.clock.advance(200_000); // past max lifetime
    const ctx = await stack.appSessions.sessionContext("alice", "bob");
    assert.equal(ctx.resolved, false);
    assert.equal(ctx.transportMode, TransportMode.FALLBACK);
  });

  it("createIfMissing returns existing, then establishes when given a secret", async () => {
    const first = await stack.appSessions.createIfMissing("alice", "bob", { sharedSecret: crypto.randomBytes(32) });
    assert.equal(first.created, true);
    const second = await stack.appSessions.createIfMissing("alice", "bob", { sharedSecret: crypto.randomBytes(32) });
    assert.equal(second.created, false);
    assert.equal(second.resolution, SessionResolution.RESOLVED);
  });

  it("descriptor mode (no key store) reports handshake-required on createIfMissing", async () => {
    const descriptor = makeStack();
    // Strip the key store to simulate the server descriptor manager.
    descriptor.secure.keyStore = null;
    const result = await descriptor.appSessions.createIfMissing("alice", "bob", { sharedSecret: crypto.randomBytes(32) });
    assert.equal(result.created, false);
    assert.equal(result.resolution, SessionResolution.HANDSHAKE_REQUIRED);
  });
});

describe("ApplicationSessionManager — caching + stats + enforcement", () => {
  it("caches pair lookups (second resolve is a cache hit)", async () => {
    const stack = makeStack();
    await establishBetween(stack.appSessions, "alice", "bob");
    await stack.appSessions.sessionContext("alice", "bob");
    await stack.appSessions.sessionContext("alice", "bob");
    const stats = await stack.appSessions.getStats();
    assert.ok(stats.repository.cacheHits >= 1);
    assert.equal(stats.metrics.counters["integration.session.resolved"], 2);
  });

  it("invalidates the cache on close", async () => {
    const stack = makeStack();
    const { session } = await establishBetween(stack.appSessions, "alice", "bob");
    await stack.appSessions.sessionContext("alice", "bob"); // populate cache
    await stack.appSessions.closeSession(session.sessionId);
    const ctx = await stack.appSessions.sessionContext("alice", "bob");
    assert.equal(ctx.resolved, false); // closed → no longer resolves
  });

  it("strict enforcement marks missing sessions for rejection", async () => {
    const stack = makeStack({ enforcement: EnforcementMode.STRICT });
    const ctx = await stack.appSessions.sessionContext("alice", "bob");
    assert.equal(stack.appSessions.shouldReject(ctx), true);
    await establishBetween(stack.appSessions, "alice", "bob");
    const ok = await stack.appSessions.sessionContext("alice", "bob");
    assert.equal(stack.appSessions.shouldReject(ok), false);
  });

  it("records handshake-fallback counts", async () => {
    const stack = makeStack();
    await stack.appSessions.sessionContext("alice", "bob");
    await stack.appSessions.sessionContext("carol", "dave");
    const stats = await stack.appSessions.getStats();
    assert.equal(stats.metrics.counters["integration.handshake.fallback"], 2);
  });
});
