import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HandshakeState } from "../../types.js";
import { ExchangeState, KeyAgreementEventType } from "../types.js";
import {
  SharedSecretMismatchError,
  DuplicateExchangeError,
  ReplayError,
  ExchangeNotFoundError,
  KeyAgreementValidationError,
  KeyAgreementExpiredError,
  InvalidPublicKeyError,
} from "../errors.js";
import {
  makeScenario,
  negotiatedHandshake,
  runFullAgreement,
  captureEvents,
} from "./helpers.js";

describe("KeyAgreementManager — full agreement", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeScenario({ withHandshake: true });
  });

  it("two devices independently derive the SAME shared secret; handshake reaches cryptographically_complete", async () => {
    const { seen } = captureEvents(ctx.events);
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    const { aDer, bDer, exchange } = await runFullAgreement({ ...ctx, handshakeId });

    assert.equal(aDer.commitment, bDer.commitment, "commitments (and thus secrets) match");
    assert.equal(exchange.state, ExchangeState.ESTABLISHED);
    assert.equal((await ctx.handshakeManager.getHandshake(handshakeId)).state, HandshakeState.CRYPTOGRAPHICALLY_COMPLETE);

    // the actual secrets are equal and device-local
    const aSecret = await ctx.alice.loadSharedSecret(handshakeId);
    const bSecret = await ctx.bob.loadSharedSecret(handshakeId);
    assert.ok(aSecret.equals(bSecret));
    assert.equal(aSecret.length, 32);

    const types = seen.map((e) => e.type);
    for (const t of [
      KeyAgreementEventType.NEGOTIATION_SUCCEEDED,
      KeyAgreementEventType.EPHEMERAL_KEY_GENERATED,
      KeyAgreementEventType.SHARED_SECRET_DERIVED,
      KeyAgreementEventType.SESSION_MATERIAL_CREATED,
      KeyAgreementEventType.KEY_AGREEMENT_COMPLETED,
    ]) {
      assert.ok(types.includes(t), `missing ${t}`);
    }
  });

  it("drives the SHS crypto sub-lifecycle step by step", async () => {
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    const at = async () => (await ctx.handshakeManager.getHandshake(handshakeId)).state;

    await ctx.server.negotiate(handshakeId, { initiator: "alice", responder: "bob" });
    assert.equal(await at(), HandshakeState.GENERATING_EPHEMERAL_KEYS);

    const a = ctx.alice.generateEphemeralKeys(handshakeId, "initiator");
    await ctx.server.submitEphemeralKey(handshakeId, "initiator", a);
    assert.equal(await at(), HandshakeState.WAITING_FOR_PEER_KEY);

    const b = ctx.bob.generateEphemeralKeys(handshakeId, "responder");
    await ctx.server.submitEphemeralKey(handshakeId, "responder", b);
    assert.equal(await at(), HandshakeState.DERIVING_SHARED_SECRET);

    const aDer = await ctx.alice.deriveAndStore(handshakeId, "initiator", (await ctx.alice.getPeerKey(handshakeId, "initiator")).publicKey);
    await ctx.server.submitCommitment(handshakeId, "initiator", aDer.commitment);
    assert.equal(await at(), HandshakeState.SHARED_SECRET_ESTABLISHED);

    const bDer = await ctx.bob.deriveAndStore(handshakeId, "responder", (await ctx.bob.getPeerKey(handshakeId, "responder")).publicKey);
    await ctx.server.submitCommitment(handshakeId, "responder", bDer.commitment);
    assert.equal(await at(), HandshakeState.CRYPTOGRAPHICALLY_COMPLETE);
  });

  it("never leaks the shared secret through public DTOs", async () => {
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await runFullAgreement({ ...ctx, handshakeId });
    const material = await ctx.alice.getSessionMaterial(handshakeId);
    assert.equal("sharedSecret" in material, false);
    assert.match(material.sharedSecretFingerprint, /^[0-9a-f]{64}$/);
    const exchange = await ctx.server.getExchange(handshakeId);
    assert.equal(JSON.stringify(exchange).includes("sharedSecret"), false);
    assert.equal(exchange.initiatorCommitted, true);
  });

  it("destroys ephemeral private keys after derivation", async () => {
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await runFullAgreement({ ...ctx, handshakeId });
    assert.equal(ctx.alice.ephemeral.size, 0);
    assert.equal(ctx.bob.ephemeral.size, 0);
  });
});

describe("KeyAgreementManager — failure & guards", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeScenario({ withHandshake: true });
  });

  it("mismatched commitments FAIL the exchange + handshake", async () => {
    const { seen } = captureEvents(ctx.events);
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await ctx.server.negotiate(handshakeId, { initiator: "alice", responder: "bob" });
    await ctx.server.submitEphemeralKey(handshakeId, "initiator", ctx.alice.generateEphemeralKeys(handshakeId, "initiator"));
    await ctx.server.submitEphemeralKey(handshakeId, "responder", ctx.bob.generateEphemeralKeys(handshakeId, "responder"));

    await ctx.server.submitCommitment(handshakeId, "initiator", "a".repeat(64));
    await assert.rejects(() => ctx.server.submitCommitment(handshakeId, "responder", "b".repeat(64)), SharedSecretMismatchError);

    assert.equal((await ctx.server.getExchange(handshakeId)).state, ExchangeState.FAILED);
    assert.equal((await ctx.handshakeManager.getHandshake(handshakeId)).state, HandshakeState.FAILED);
    assert.ok(seen.some((e) => e.type === KeyAgreementEventType.KEY_AGREEMENT_FAILED));
  });

  it("rejects duplicate and replayed ephemeral keys", async () => {
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await ctx.server.negotiate(handshakeId, { initiator: "alice", responder: "bob" });
    const a = ctx.alice.generateEphemeralKeys(handshakeId, "initiator");
    await ctx.server.submitEphemeralKey(handshakeId, "initiator", a);
    // duplicate submission for the same role
    await assert.rejects(() => ctx.server.submitEphemeralKey(handshakeId, "initiator", ctx.alice.generateEphemeralKeys(handshakeId, "initiator")), DuplicateExchangeError);
    // replay of the same key bytes as the other role
    await assert.rejects(() => ctx.server.submitEphemeralKey(handshakeId, "responder", a), ReplayError);
  });

  it("rejects a small-order peer key at submission", async () => {
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await ctx.server.negotiate(handshakeId, { initiator: "alice", responder: "bob" });
    const bad = { algorithm: "x25519", publicKey: Buffer.alloc(32).toString("base64"), keyId: "k", version: 1 };
    await assert.rejects(() => ctx.server.submitEphemeralKey(handshakeId, "initiator", bad), InvalidPublicKeyError);
  });

  it("unknown handshake and invalid role", async () => {
    await assert.rejects(() => ctx.server.getExchange("nope"), ExchangeNotFoundError);
    await assert.rejects(() => ctx.server.negotiate("h", { initiator: "a", responder: "b" }).then(() => ctx.server.submitEphemeralKey("h", "bogus", {})), KeyAgreementValidationError);
  });

  it("expires stale exchanges via sweepExpired", async () => {
    ctx = makeScenario({ withHandshake: true, ttlMs: 1000 });
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await ctx.server.negotiate(handshakeId, { initiator: "alice", responder: "bob" });
    ctx.clock.advance(2000);
    const result = await ctx.server.sweepExpired();
    assert.equal(result.failed, 1);
    assert.equal((await ctx.server.getExchange(handshakeId)).state, ExchangeState.FAILED);
    assert.equal((await ctx.handshakeManager.getHandshake(handshakeId)).state, HandshakeState.FAILED);
  });

  it("submitting a key to an expired exchange is rejected", async () => {
    ctx = makeScenario({ withHandshake: true, ttlMs: 1000 });
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await ctx.server.negotiate(handshakeId, { initiator: "alice", responder: "bob" });
    ctx.clock.advance(2000);
    await assert.rejects(
      () => ctx.server.submitEphemeralKey(handshakeId, "initiator", ctx.alice.generateEphemeralKeys(handshakeId, "initiator")),
      KeyAgreementExpiredError,
    );
  });

  it("relay (no material repo) cannot derive/store secrets", async () => {
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await ctx.server.negotiate(handshakeId, { initiator: "alice", responder: "bob" });
    await assert.rejects(() => ctx.server.deriveAndStore(handshakeId, "initiator", "x"), KeyAgreementValidationError);
    await assert.rejects(() => ctx.server.loadSharedSecret(handshakeId), KeyAgreementValidationError);
  });
});

describe("KeyAgreementManager — standalone (no SHS session) + concurrency", () => {
  it("works without an SHS session repo (pure crypto library)", async () => {
    const ctx = makeScenario({ withHandshake: false });
    const { aDer, bDer, exchange } = await runFullAgreement({ ...ctx, handshakeId: "hs-x" });
    assert.equal(aDer.commitment, bDer.commitment);
    assert.equal(exchange.state, ExchangeState.ESTABLISHED);
  });

  it("supports many concurrent independent agreements with unique secrets", async () => {
    const ctx = makeScenario({ withHandshake: false });
    const ids = ["h1", "h2", "h3", "h4", "h5"];
    const results = await Promise.all(ids.map((id) => runFullAgreement({ ...ctx, handshakeId: id })));
    const fingerprints = results.map((r) => r.aDer.commitment);
    assert.equal(new Set(fingerprints).size, ids.length); // all distinct
    for (const r of results) assert.equal(r.exchange.state, ExchangeState.ESTABLISHED);
  });

  it("repeated handshakes for the same pair each get fresh secrets", async () => {
    const ctx = makeScenario({ withHandshake: false });
    const r1 = await runFullAgreement({ ...ctx, handshakeId: "r1" });
    const r2 = await runFullAgreement({ ...ctx, handshakeId: "r2" });
    assert.notEqual(r1.aDer.commitment, r2.aDer.commitment);
  });
});
