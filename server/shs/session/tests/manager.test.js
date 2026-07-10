import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SessionState, SessionEventType } from "../types.js";
import {
  SessionError,
  DuplicateSessionError,
  SessionNotFoundError,
  ParticipantMismatchError,
  SessionValidationError,
  DeviceModeRequiredError,
  InvalidSessionTransitionError,
} from "../errors.js";
import { makeManager, establish, captureEvents, makeSecret } from "./helpers.js";

describe("SecureSessionManager — establishment", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("establishes an active session with key metadata (no key bytes)", async () => {
    const { seen } = captureEvents(ctx.events);
    const s = await establish(ctx.manager);
    assert.equal(s.status, SessionState.ACTIVE);
    assert.equal(s.participants.length, 2);
    assert.match(s.encryptionKey.keyId, /^[0-9a-f]{32}$/);
    assert.equal(s.encryptionKey.algorithm, "aes-256-gcm");
    assert.equal(s.authenticationKey.algorithm, "hmac-sha256");
    assert.equal(JSON.stringify(s).includes("bytes"), false);
    assert.equal(s.security.kdf, "hkdf-sha256");
    const types = seen.map((e) => e.type);
    assert.ok(types.includes(SessionEventType.CREATED));
    assert.ok(types.includes(SessionEventType.ACTIVATED));
  });

  it("device keys are loadable locally + match a peer's derivation", async () => {
    const secret = makeSecret(7);
    const s = await establish(ctx.manager, { sharedSecret: secret });
    const keys = ctx.manager.loadSessionKeys(s.sessionId);
    assert.equal(keys.encryptionKey.length, 32);
    // a second manager (the peer) with the SAME secret + context derives the same keys
    const peer = makeManager().manager;
    const ps = await establish(peer, { sharedSecret: secret });
    assert.equal(s.encryptionKey.keyId, ps.encryptionKey.keyId);
    assert.equal(s.encryptionKey.fingerprint, ps.encryptionKey.fingerprint);
    assert.ok(keys.encryptionKey.equals(peer.loadSessionKeys(ps.sessionId).encryptionKey));
  });

  it("rejects a duplicate active session for the same handshake", async () => {
    await establish(ctx.manager);
    await assert.rejects(() => establish(ctx.manager), DuplicateSessionError);
  });

  it("rejects bad participants", async () => {
    await assert.rejects(() => establish(ctx.manager, { participants: ["alice"] }), SessionValidationError);
    await assert.rejects(() => establish(ctx.manager, { participants: ["a", "a"] }), SessionValidationError);
  });

  it("descriptor mode (server): registers metadata, cannot load keys", async () => {
    const server = makeManager({ descriptorMode: true }).manager;
    const s = await server.registerSession({
      handshakeId: "hs-1",
      participants: ["alice", "bob"],
      deviceIds: { initiator: "devA", responder: "devB" },
      encryptionKeyMeta: { algorithm: "aes-256-gcm", length: 32, keyId: "abc123", fingerprint: "fp" },
    });
    assert.equal(s.status, SessionState.ACTIVE);
    assert.throws(() => server.loadSessionKeys(s.sessionId), DeviceModeRequiredError);
    await assert.rejects(() => server.establishSession({ handshakeId: "h2", participants: ["a", "b"], sharedSecret: makeSecret() }), DeviceModeRequiredError);
  });
});

describe("SecureSessionManager — lifecycle", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager({ idleTimeoutMs: 1000, maxLifetimeMs: 10000 });
  });

  it("activity → idle (on read) → activity wakes it", async () => {
    const s = await establish(ctx.manager);
    ctx.clock.advance(1500);
    assert.equal((await ctx.manager.getSession(s.sessionId)).status, SessionState.IDLE);
    const woken = await ctx.manager.trackActivity(s.sessionId);
    assert.equal(woken.status, SessionState.ACTIVE);
  });

  it("pause → resume (token) → active; reuses keys (no re-derive)", async () => {
    const s = await establish(ctx.manager);
    const beforeKeyId = s.encryptionKey.keyId;
    await ctx.manager.pauseSession(s.sessionId);
    assert.equal((await ctx.manager.getSession(s.sessionId)).status, SessionState.PAUSED);
    const token = ctx.manager.issueResumeToken(s.sessionId);
    const resumed = await ctx.manager.resumeSession(s.sessionId, { token });
    assert.equal(resumed.status, SessionState.ACTIVE);
    assert.equal(resumed.encryptionKey.keyId, beforeKeyId); // keys unchanged
  });

  it("resume rejects a token for another session", async () => {
    const a = await establish(ctx.manager, { handshakeId: "hA" });
    const b = await establish(ctx.manager, { handshakeId: "hB" });
    await ctx.manager.pauseSession(b.sessionId);
    const tokenForA = ctx.manager.issueResumeToken(a.sessionId);
    // Rejected either by B's HMAC (different resumption key) or the sessionId check —
    // both are SessionErrors and both are correct.
    await assert.rejects(() => ctx.manager.resumeSession(b.sessionId, { token: tokenForA }), SessionError);
  });

  it("close wipes local keys; destroy removes the record", async () => {
    const s = await establish(ctx.manager);
    await ctx.manager.closeSession(s.sessionId);
    assert.equal((await ctx.manager.getSession(s.sessionId)).status, SessionState.CLOSED);
    assert.throws(() => ctx.manager.loadSessionKeys(s.sessionId), DeviceModeRequiredError);

    const s2 = await establish(ctx.manager, { handshakeId: "hs-2" });
    const res = await ctx.manager.destroySession(s2.sessionId);
    assert.equal(res.destroyed, true);
    await assert.rejects(() => ctx.manager.getSession(s2.sessionId), SessionNotFoundError);
  });

  it("expires on read past hard lifetime; sweepExpired cleans up", async () => {
    const { seen } = captureEvents(ctx.events);
    const s = await establish(ctx.manager);
    await establish(ctx.manager, { handshakeId: "hs-2" });
    ctx.clock.advance(11000);
    assert.equal((await ctx.manager.getSession(s.sessionId)).status, SessionState.EXPIRED);
    const swept = await ctx.manager.sweepExpired();
    assert.equal(swept.expired, 1); // the other one (first already expired on read)
    assert.ok(seen.some((e) => e.type === SessionEventType.EXPIRED));
  });

  it("rotateMetadata merges metadata but never keys", async () => {
    const s = await establish(ctx.manager);
    const up = await ctx.manager.rotateMetadata(s.sessionId, { label: "primary" });
    assert.equal(up.metadata.label, "primary");
    assert.equal(up.encryptionKey.keyId, s.encryptionKey.keyId);
  });

  it("validateSession reports validity; participant enforced", async () => {
    const s = await establish(ctx.manager);
    const v = await ctx.manager.validateSession(s.sessionId, { actingUser: "alice" });
    assert.equal(v.valid, true);
    await assert.rejects(() => ctx.manager.validateSession(s.sessionId, { actingUser: "carol" }), ParticipantMismatchError);
  });

  it("illegal transition guarded (resume a closed session)", async () => {
    const s = await establish(ctx.manager);
    await ctx.manager.closeSession(s.sessionId);
    await assert.rejects(() => ctx.manager.resumeSession(s.sessionId), InvalidSessionTransitionError);
  });
});

describe("SecureSessionManager — rekey", () => {
  it("rekey bumps generation, changes keys + keyId, records history", async () => {
    const ctx = makeManager();
    const { seen } = captureEvents(ctx.events);
    const s = await establish(ctx.manager);
    const before = ctx.manager.loadSessionKeys(s.sessionId).encryptionKey;
    const rk = await ctx.manager.rekey(s.sessionId, { reason: "manual" });
    assert.equal(rk.generation, 1);
    assert.notEqual(rk.encryptionKey.keyId, s.encryptionKey.keyId);
    assert.equal(rk.rekeyHistory.length, 1);
    assert.ok(!ctx.manager.loadSessionKeys(s.sessionId).encryptionKey.equals(before));
    const types = seen.map((e) => e.type);
    assert.ok(types.includes(SessionEventType.REKEY_REQUESTED));
    assert.ok(types.includes(SessionEventType.REKEYED));
  });

  it("descriptor mode cannot rekey", async () => {
    const server = makeManager({ descriptorMode: true }).manager;
    await server.registerSession({ handshakeId: "h", participants: ["a", "b"], encryptionKeyMeta: { algorithm: "aes-256-gcm", length: 32, keyId: "k", fingerprint: "f" } });
    const active = await server.getActiveByHandshake("h");
    await assert.rejects(() => server.rekey(active.sessionId), DeviceModeRequiredError);
  });
});

describe("SecureSessionManager — concurrency, multi-device, stress", () => {
  it("many concurrent sessions across handshakes with distinct keys", async () => {
    const ctx = makeManager();
    const ids = ["h1", "h2", "h3", "h4", "h5"];
    const sessions = await Promise.all(ids.map((h, i) => establish(ctx.manager, { handshakeId: h, seed: i + 1 })));
    assert.equal(new Set(sessions.map((s) => s.sessionId)).size, 5);
    assert.equal(new Set(sessions.map((s) => s.encryptionKey.keyId)).size, 5); // distinct keys
  });

  it("multiple devices / sessions per user are listed", async () => {
    const ctx = makeManager();
    await establish(ctx.manager, { handshakeId: "h1", participants: ["alice", "bob"] });
    await establish(ctx.manager, { handshakeId: "h2", participants: ["alice", "carol"] });
    const aliceSessions = await ctx.manager.listSessions("alice");
    assert.equal(aliceSessions.length, 2);
    assert.equal((await ctx.manager.listSessions("bob")).length, 1);
    assert.equal((await ctx.manager.listByState(SessionState.ACTIVE)).length, 2);
  });

  it("stress: 50 sequential establish/close cycles stay consistent", async () => {
    const ctx = makeManager();
    for (let i = 0; i < 50; i++) {
      const s = await establish(ctx.manager, { handshakeId: `h${i}`, seed: i });
      assert.equal(s.status, SessionState.ACTIVE);
      await ctx.manager.closeSession(s.sessionId);
    }
    assert.equal((await ctx.manager.listByState(SessionState.CLOSED)).length, 50);
    assert.equal(ctx.keyStore.size, 0); // all keys wiped on close
  });
});
