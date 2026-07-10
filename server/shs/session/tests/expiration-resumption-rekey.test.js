import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  isExpired,
  isLifetimeExpired,
  isIdleExpired,
  shouldGoIdle,
  remainingLifetimeMs,
  selectExpired,
} from "../expiration/expiration.js";
import { issueResumeToken, verifyResumeToken, DEFAULT_RESUME_TOKEN_TTL_MS } from "../resumption/resumption.js";
import { hkdfGenerationStrategy, resolveStrategy, canRekey, rekeyRecord } from "../rekey/rekey.js";
import { deriveSessionKeys } from "../derivation/sessionKeys.js";
import { createSecureSession } from "../model/secureSession.js";
import { ResumptionError, RekeyError } from "../errors.js";
import { makeClock } from "./helpers.js";

const session = (over = {}) =>
  createSecureSession({
    handshakeId: "hs-1",
    participants: ["alice", "bob"],
    encryptionKeyMeta: { algorithm: "aes-256-gcm", length: 32, keyId: "k", fingerprint: "f" },
    authenticationKeyMeta: { algorithm: "hmac-sha256", length: 32 },
    clock: makeClock(1000),
    maxLifetimeMs: 10000,
    idleTimeoutMs: 2000,
    ...over,
  });

describe("expiration policies", () => {
  it("hard lifetime expiry", () => {
    const s = session();
    assert.equal(isLifetimeExpired(s, 5000), false);
    assert.equal(isLifetimeExpired(s, 11001), true);
    assert.equal(isExpired(s, 11001), true);
    assert.equal(remainingLifetimeMs(s, 6000), 5000);
    assert.equal(remainingLifetimeMs(s, 20000), 0);
  });

  it("idle timeout maps to idle, not expiry", () => {
    const s = { ...session(), status: "active", lastActivityAt: new Date(1000).toISOString() };
    assert.equal(isIdleExpired(s, 2500), false);
    assert.equal(isIdleExpired(s, 3500), true); // 2000ms idle window elapsed
    assert.equal(shouldGoIdle(s, 3500), true);
    assert.equal(shouldGoIdle(s, 3500 + 10000), false); // past hard lifetime → not "idle"
  });

  it("selectExpired picks only active-family past lifetime", () => {
    const active = { ...session(), sessionId: "a", status: "active" };
    const closed = { ...session(), sessionId: "b", status: "closed" };
    const picked = selectExpired([active, closed], 20000);
    assert.deepEqual(picked.map((s) => s.sessionId), ["a"]);
  });
});

describe("resumption tokens", () => {
  const resumptionKey = crypto.randomBytes(32);
  it("issues + verifies a valid token", () => {
    const token = issueResumeToken({ sessionId: "s-1", keyId: "k", generation: 0, resumptionKey, clock: () => 1000 });
    const decoded = verifyResumeToken(token, resumptionKey, { clock: () => 2000 });
    assert.equal(decoded.sessionId, "s-1");
    assert.equal(decoded.generation, 0);
    assert.equal(decoded.expiresAt, 1000 + DEFAULT_RESUME_TOKEN_TTL_MS);
  });

  it("rejects tampered signature, wrong key, expiry, malformed", () => {
    const token = issueResumeToken({ sessionId: "s-1", keyId: "k", generation: 0, resumptionKey, clock: () => 1000 });
    assert.throws(() => verifyResumeToken(token, crypto.randomBytes(32)), ResumptionError); // wrong key
    assert.throws(() => verifyResumeToken(token + "x", resumptionKey), ResumptionError); // tampered
    assert.throws(() => verifyResumeToken(token, resumptionKey, { clock: () => 1000 + DEFAULT_RESUME_TOKEN_TTL_MS + 1 }), ResumptionError); // expired
    assert.throws(() => verifyResumeToken("not.a.token", resumptionKey), ResumptionError);
  });
});

describe("rekey framework (NOT forward secrecy)", () => {
  const ctx = { handshakeId: "hs-1", participants: ["alice", "bob"], deviceIds: {}, protocolVersion: "1.0" };
  it("hkdf-generation strategy re-derives new keys at the next generation", () => {
    const secret = crypto.randomBytes(32);
    const current = deriveSessionKeys(secret, ctx, { generation: 0 });
    const next = hkdfGenerationStrategy({ sharedSecret: secret, nextGeneration: 1, derivationContext: ctx });
    assert.equal(next.generation, 1);
    assert.ok(!next.encryptionKey.equals(current.encryptionKey));
    // deterministic — both peers rekey to the same keys
    const next2 = hkdfGenerationStrategy({ sharedSecret: secret, nextGeneration: 1, derivationContext: ctx });
    assert.ok(next.encryptionKey.equals(next2.encryptionKey));
  });

  it("strategy resolution + guards", () => {
    assert.equal(typeof resolveStrategy("hkdf-generation"), "function");
    assert.throws(() => resolveStrategy("bogus"), RekeyError);
    assert.throws(() => hkdfGenerationStrategy({ nextGeneration: 1, derivationContext: ctx }), RekeyError); // no secret
    const fn = () => ({});
    assert.equal(resolveStrategy(fn), fn);
  });

  it("canRekey only for active-family; rekeyRecord shape", () => {
    assert.equal(canRekey({ status: "active" }), true);
    assert.equal(canRekey({ status: "closed" }), false);
    const rec = rekeyRecord({ generation: 2, reason: "manual", at: 1000 });
    assert.equal(rec.generation, 2);
    assert.equal(rec.strategy, "hkdf-generation");
  });
});
