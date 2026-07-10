import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryKeyAgreementRepositories } from "../repository/inMemoryRepository.js";
import { KeyAgreementEventBus } from "../events/keyAgreementEvents.js";
import { createSessionMaterial, isMaterialExpired, materialSecretBytes } from "../session/sessionMaterial.js";
import { toPublicSessionMaterial, toPublicExchange } from "../serialization/keyAgreementSerializer.js";
import { ExchangeState, KeyAgreementEventType } from "../types.js";
import { ExchangeNotFoundError, SessionMaterialNotFoundError } from "../errors.js";
import { keyAgreementReport, sweepExpiredExchanges, KEY_AGREEMENT_SCHEMA_VERSION } from "../migration/migration.js";
import { makeScenario, negotiatedHandshake, runFullAgreement, makeClock } from "./helpers.js";
import crypto from "node:crypto";

describe("in-memory repositories", () => {
  let repos;
  beforeEach(() => {
    repos = createInMemoryKeyAgreementRepositories();
  });

  const exchange = (over = {}) => ({
    handshakeId: "h1",
    initiator: "alice",
    responder: "bob",
    algorithm: "x25519",
    cryptoVersion: "1.0",
    state: ExchangeState.AWAITING_INITIATOR_KEY,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    ...over,
  });

  it("exchanges: create / find / update / delete / active / listByUser / byState", async () => {
    await repos.exchanges.create(exchange());
    assert.equal((await repos.exchanges.findById("h1")).initiator, "alice");
    assert.equal((await repos.exchanges.findActive("h1")).handshakeId, "h1");
    await repos.exchanges.update("h1", { state: ExchangeState.ESTABLISHED });
    assert.equal(await repos.exchanges.findActive("h1"), null); // terminal → not active
    assert.equal((await repos.exchanges.findByState(ExchangeState.ESTABLISHED)).length, 1);
    assert.equal((await repos.exchanges.listByUser("bob")).length, 1);
    assert.equal(await repos.exchanges.delete("h1"), true);
    await assert.rejects(() => repos.exchanges.update("h1", {}), ExchangeNotFoundError);
  });

  it("exchanges store deep copies", async () => {
    const rec = exchange();
    await repos.exchanges.create(rec);
    rec.metadata = { mutated: true };
    assert.equal((await repos.exchanges.findById("h1")).metadata?.mutated, undefined);
  });

  it("material: create / find / delete / history; never mutated by reference", async () => {
    const mat = createSessionMaterial({ handshakeId: "h1", sharedSecret: crypto.randomBytes(32), fingerprint: "f", algorithm: "x25519", idGenerator: () => "s1" });
    await repos.material.create(mat);
    assert.equal((await repos.material.findByHandshake("h1")).sessionId, "s1");
    assert.equal((await repos.material.findById("s1")).handshakeId, "h1");
    const history = await repos.material.history();
    assert.equal(history.length, 1);
    assert.equal("sharedSecret" in history[0], false); // history holds metadata only
    assert.equal(await repos.material.deleteByHandshake("h1"), true);
    await assert.rejects(() => repos.material.requireByHandshake("h1"), SessionMaterialNotFoundError);
  });
});

describe("session material", () => {
  it("stores the secret as base64; DTO strips it; secret bytes recoverable locally", () => {
    const secret = crypto.randomBytes(32);
    const mat = createSessionMaterial({ handshakeId: "h", sharedSecret: secret, fingerprint: "fp", algorithm: "x25519", clock: makeClock(1000), ttlMs: 5000 });
    assert.equal(mat.sharedSecret, secret.toString("base64"));
    assert.ok(materialSecretBytes(mat).equals(secret));
    const dto = toPublicSessionMaterial(mat);
    assert.equal("sharedSecret" in dto, false);
    assert.equal(dto.sharedSecretFingerprint, "fp");
    assert.equal(dto.security.keyLength, 32);
    assert.equal(dto.hasSharedSecret, true);
  });

  it("expiry check", () => {
    const mat = createSessionMaterial({ handshakeId: "h", sharedSecret: crypto.randomBytes(32), fingerprint: "fp", algorithm: "x25519", clock: makeClock(1000), ttlMs: 1000 });
    assert.equal(isMaterialExpired(mat, 1500), false);
    assert.equal(isMaterialExpired(mat, 3000), true);
  });

  it("toPublicExchange reduces commitments to booleans by default", () => {
    const dto = toPublicExchange({
      handshakeId: "h", initiator: "a", responder: "b", algorithm: "x25519", cryptoVersion: "1.0",
      initiatorCommitment: "x", responderCommitment: undefined, state: "keys_exchanged", createdAt: "t",
    });
    assert.equal(dto.initiatorCommitted, true);
    assert.equal(dto.responderCommitted, false);
    assert.equal("initiatorCommitment" in dto, false);
  });
});

describe("event bus + migration", () => {
  it("delivers typed + wildcard events, unsubscribe works", () => {
    const bus = new KeyAgreementEventBus();
    const specific = [];
    const all = [];
    const off = bus.on(KeyAgreementEventType.SHARED_SECRET_DERIVED, (e) => specific.push(e));
    bus.on("*", (e) => all.push(e));
    bus.emit(KeyAgreementEventType.SHARED_SECRET_DERIVED, { handshakeId: "h" });
    off();
    bus.emit(KeyAgreementEventType.SHARED_SECRET_DERIVED, { handshakeId: "h" });
    assert.equal(specific.length, 1);
    assert.equal(all.length, 2);
    assert.ok(typeof all[0].at === "number");
  });

  it("reports adoption + sweeps expired", async () => {
    assert.equal(typeof KEY_AGREEMENT_SCHEMA_VERSION, "number");
    const ctx = makeScenario({ withHandshake: true });
    const handshakeId = await negotiatedHandshake(ctx.handshakeManager);
    await runFullAgreement({ ...ctx, handshakeId });
    const report = await keyAgreementReport({ keyAgreementManager: ctx.server, userId: "alice" });
    assert.equal(report.total, 1);
    assert.equal(report.established, 1);

    const ctx2 = makeScenario({ withHandshake: false, ttlMs: 1000 });
    await ctx2.server.negotiate("h", { initiator: "alice", responder: "bob" });
    ctx2.clock.advance(2000);
    const swept = await sweepExpiredExchanges({ keyAgreementManager: ctx2.server });
    assert.equal(swept.failed, 1);
  });
});

describe("performance / repeated handshakes", () => {
  it("completes 25 sequential agreements quickly with all-distinct secrets", async () => {
    const ctx = makeScenario({ withHandshake: false });
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      const { aDer, bDer } = await runFullAgreement({ ...ctx, handshakeId: `p${i}` });
      assert.equal(aDer.commitment, bDer.commitment);
      seen.add(aDer.commitment);
    }
    assert.equal(seen.size, 25);
  });
});
