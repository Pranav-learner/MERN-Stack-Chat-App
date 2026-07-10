import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  deriveSessionKeys,
  disposeSessionKeys,
  buildContext,
  infoLabel,
} from "../derivation/sessionKeys.js";
import {
  canTransition,
  assertTransition,
  nextStates,
  SessionLifecycle,
  ALLOWED_TRANSITIONS,
} from "../lifecycle/lifecycle.js";
import { SessionState, ALL_SESSION_STATES, TERMINAL_SESSION_STATES, KeyPurpose } from "../types.js";
import { InvalidSessionTransitionError, KeyDerivationError } from "../errors.js";

const ctx = { handshakeId: "hs-1", participants: ["alice", "bob"], deviceIds: { initiator: "a", responder: "b" }, protocolVersion: "1.0" };

describe("session key derivation", () => {
  it("both peers derive identical keys (symmetric context)", () => {
    const secret = crypto.randomBytes(32);
    const a = deriveSessionKeys(secret, { ...ctx, participants: ["alice", "bob"] });
    const b = deriveSessionKeys(secret, { ...ctx, participants: ["bob", "alice"] }); // order-independent
    assert.ok(a.encryptionKey.equals(b.encryptionKey));
    assert.ok(a.macKey.equals(b.macKey));
    assert.equal(a.keyId, b.keyId);
    assert.equal(a.keyFingerprint, b.keyFingerprint);
  });

  it("purpose separation → all derived keys are distinct", () => {
    const keys = deriveSessionKeys(crypto.randomBytes(32), ctx);
    const set = new Set([keys.encryptionKey, keys.macKey, keys.ratchetMaterial, keys.resumptionKey].map((b) => b.toString("hex")));
    assert.equal(set.size, 4);
    assert.equal(keys.encryptionKey.length, 32);
    assert.equal(keys.initMaterial.length, 16);
  });

  it("context separation → different handshake/participants → different keys", () => {
    const secret = crypto.randomBytes(32);
    const base = deriveSessionKeys(secret, ctx);
    assert.ok(!deriveSessionKeys(secret, { ...ctx, handshakeId: "hs-2" }).encryptionKey.equals(base.encryptionKey));
    assert.ok(!deriveSessionKeys(secret, { ...ctx, participants: ["alice", "carol"] }).encryptionKey.equals(base.encryptionKey));
  });

  it("generation (rekey) → different keys, deterministic", () => {
    const secret = crypto.randomBytes(32);
    const g0 = deriveSessionKeys(secret, ctx, { generation: 0 });
    const g1a = deriveSessionKeys(secret, ctx, { generation: 1 });
    const g1b = deriveSessionKeys(secret, ctx, { generation: 1 });
    assert.ok(!g0.encryptionKey.equals(g1a.encryptionKey));
    assert.ok(g1a.encryptionKey.equals(g1b.encryptionKey)); // deterministic
  });

  it("public keyId + fingerprint format; keyId is not the key", () => {
    const keys = deriveSessionKeys(crypto.randomBytes(32), ctx);
    assert.match(keys.keyId, /^[0-9a-f]{32}$/);
    assert.match(keys.keyFingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(keys.keyId, keys.encryptionKey.toString("hex"));
  });

  it("rejects an empty secret; disposes secret buffers", () => {
    assert.throws(() => deriveSessionKeys(Buffer.alloc(0), ctx), KeyDerivationError);
    const keys = deriveSessionKeys(crypto.randomBytes(32), ctx);
    disposeSessionKeys(keys);
    assert.ok(keys.encryptionKey.equals(Buffer.alloc(32)));
    assert.ok(keys.macKey.equals(Buffer.alloc(32)));
  });

  it("context + info labels are stable strings", () => {
    assert.equal(buildContext({ ...ctx, participants: ["bob", "alice"] }), buildContext(ctx));
    assert.match(infoLabel("x", KeyPurpose.ENCRYPTION, 0).toString(), /purpose=encryption\|gen=0/);
  });
});

describe("session lifecycle FSM", () => {
  it("every state has a transition list; terminals resolved", () => {
    for (const s of ALL_SESSION_STATES) assert.ok(Array.isArray(ALLOWED_TRANSITIONS[s]), `missing ${s}`);
    assert.deepEqual(ALLOWED_TRANSITIONS[SessionState.DESTROYED], []);
  });

  it("canonical happy path is legal", () => {
    assert.ok(canTransition(SessionState.CREATED, SessionState.ACTIVE));
    assert.ok(canTransition(SessionState.ACTIVE, SessionState.IDLE));
    assert.ok(canTransition(SessionState.IDLE, SessionState.RESUMED));
    assert.ok(canTransition(SessionState.RESUMED, SessionState.ACTIVE));
    assert.ok(canTransition(SessionState.ACTIVE, SessionState.CLOSED));
    assert.ok(canTransition(SessionState.CLOSED, SessionState.DESTROYED));
  });

  it("illegal transitions rejected", () => {
    assert.equal(canTransition(SessionState.CREATED, SessionState.RESUMED), false);
    assert.equal(canTransition(SessionState.DESTROYED, SessionState.ACTIVE), false);
    assert.equal(canTransition(SessionState.CLOSED, SessionState.ACTIVE), false);
    assert.throws(() => assertTransition(SessionState.DESTROYED, SessionState.ACTIVE), InvalidSessionTransitionError);
  });

  it("all terminal states can only reach destroyed (or failed for invalid)", () => {
    for (const t of TERMINAL_SESSION_STATES) {
      for (const to of nextStates(t)) {
        assert.ok([SessionState.DESTROYED, SessionState.FAILED].includes(to), `${t}→${to}`);
      }
    }
  });

  it("SessionLifecycle drives + records history; rejects from terminal", () => {
    const fsm = new SessionLifecycle();
    fsm.transition(SessionState.ACTIVE);
    fsm.transition(SessionState.PAUSED, { reason: "user" });
    fsm.transition(SessionState.RESUMED);
    fsm.transition(SessionState.ACTIVE);
    assert.equal(fsm.state, SessionState.ACTIVE);
    assert.equal(fsm.history.length, 4);
    assert.equal(fsm.history[1].reason, "user");
    fsm.transition(SessionState.DESTROYED);
    assert.equal(fsm.isTerminal, true);
    assert.throws(() => fsm.transition(SessionState.ACTIVE), InvalidSessionTransitionError);
  });
});
