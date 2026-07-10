/**
 * End-to-end session-integration: the full request path (middleware → pipeline →
 * transport) that a session-aware messaging controller runs, plus concurrent users,
 * multiple devices, failure recovery, and a Layer-5 encryption drill.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TransportMode, SessionResolution } from "../types.js";
import { setEncryptionInterceptor, resetEncryptionInterceptor } from "../interceptors/encryptionInterceptor.js";
import { pipelineInputFromRequest, makeRestTransport } from "../adapters/restAdapter.js";
import { sessionMetadataOf } from "../transport/securePayload.js";
import { makeStack, establishBetween, fakeReq, fakeRes, runMiddleware, recordingTransport } from "./helpers.js";

/** Simulate the sendMessage controller path: resolveSession → pipeline(persist+emit). */
async function sendViaController(stack, senderId, peerId, body, store) {
  const req = fakeReq(senderId, { id: peerId }, body);
  const res = fakeRes();
  await runMiddleware(stack.middleware.resolveSession, req, res);

  const input = pipelineInputFromRequest(req);
  const emitted = [];
  const transport = makeRestTransport({
    persist: async (payload, meta) => {
      const doc = { _id: `m${store.length + 1}`, senderId, receiverId: peerId, ...payload, session: meta };
      store.push(doc);
      return doc;
    },
    emit: async (message, envelope) => emitted.push({ id: message._id, secured: envelope.secured }),
  });
  const result = await stack.pipeline.process({ ...input, transport });
  return { result, req, emitted };
}

describe("session-integration — end-to-end controller path", () => {
  afterEach(() => resetEncryptionInterceptor());

  it("persists messages with session metadata (fallback then session-backed)", async () => {
    const stack = makeStack();
    const store = [];

    // 1. no session yet → fallback, message tagged accordingly.
    const a = await sendViaController(stack, "alice", "bob", { text: "hi" }, store);
    assert.equal(a.result.context.transportMode, TransportMode.FALLBACK);
    assert.equal(store[0].session.fallback, true);
    assert.equal(store[0].session.secured, false);

    // 2. establish a session → subsequent message is session-backed.
    await establishBetween(stack.appSessions, "alice", "bob");
    const b = await sendViaController(stack, "alice", "bob", { text: "yo" }, store);
    assert.equal(b.result.context.transportMode, TransportMode.SESSION);
    assert.equal(store[1].session.transportMode, "session");
    assert.ok(store[1].session.sessionId);
    assert.equal(store[1].session.secured, false); // no encryption in Layer 4
    assert.equal(b.emitted[0].secured, false);
  });

  it("Layer 5 drill: registering an interceptor secures new messages, app path unchanged", async () => {
    const stack = makeStack();
    const store = [];
    await establishBetween(stack.appSessions, "alice", "bob");
    setEncryptionInterceptor({
      name: "aes-256-gcm",
      encryptOutbound: (e) => ({ ...e, secured: true, encryption: { algorithm: "aes-256-gcm", ciphertext: "<c>" }, payload: { text: null } }),
      decryptInbound: (e) => e,
    });
    const { result } = await sendViaController(stack, "alice", "bob", { text: "secret" }, store);
    assert.equal(result.envelope.secured, true);
    assert.equal(store[0].session.secured, true);
  });
});

describe("session-integration — concurrency + multiple devices + recovery", () => {
  it("handles many concurrent users with correct per-pair resolution", async () => {
    const stack = makeStack();
    const pairs = Array.from({ length: 25 }, (_, i) => [`u${i}`, `v${i}`]);
    // Establish sessions for the even pairs only.
    for (let i = 0; i < pairs.length; i += 2) await establishBetween(stack.appSessions, pairs[i][0], pairs[i][1]);

    const contexts = await Promise.all(pairs.map(([a, b]) => stack.appSessions.sessionContext(a, b)));
    contexts.forEach((ctx, i) => {
      const expected = i % 2 === 0 ? TransportMode.SESSION : TransportMode.FALLBACK;
      assert.equal(ctx.transportMode, expected, `pair ${i}`);
    });
  });

  it("supports multiple sessions per user (different peers)", async () => {
    const stack = makeStack();
    await establishBetween(stack.appSessions, "alice", "bob");
    await establishBetween(stack.appSessions, "alice", "carol");
    const ab = await stack.appSessions.sessionContext("alice", "bob");
    const ac = await stack.appSessions.sessionContext("alice", "carol");
    assert.equal(ab.resolved, true);
    assert.equal(ac.resolved, true);
    assert.notEqual(ab.sessionId, ac.sessionId);
  });

  it("recovers gracefully: expired session → fallback, resume → session again", async () => {
    const stack = makeStack({ maxLifetimeMs: 10_000, idleTimeoutMs: 2_000 });
    const { session } = await establishBetween(stack.appSessions, "alice", "bob");
    assert.equal((await stack.appSessions.sessionContext("alice", "bob")).resolved, true);

    // Idle it (a read lazily persists the idle transition), then resume — still resolves.
    stack.clock.advance(3_000);
    await stack.secure.getSession(session.sessionId); // triggers active → idle
    await stack.appSessions.resumeSession(session.sessionId, "alice");
    assert.equal((await stack.appSessions.sessionContext("alice", "bob")).resolved, true);

    // Now blow past the hard lifetime → fallback (graceful, no throw).
    stack.clock.advance(20_000);
    const ctx = await stack.appSessions.sessionContext("alice", "bob");
    assert.equal(ctx.resolved, false);
    assert.equal(ctx.transportMode, TransportMode.FALLBACK);
  });

  it("session metadata helper never leaks secrets", async () => {
    const stack = makeStack();
    const { session } = await establishBetween(stack.appSessions, "alice", "bob");
    const full = await stack.secure.getSession(session.sessionId);
    const meta = sessionMetadataOf({ sessionId: full.sessionId, keyId: full.encryptionKey.keyId, secured: false, transportMode: "session", fallback: false });
    assert.equal(JSON.stringify(meta).includes("bytes"), false);
    assert.equal(meta.secured, false);
  });
});
