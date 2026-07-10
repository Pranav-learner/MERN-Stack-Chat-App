import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveMessageKey } from "../derivation/derivation.js";
import { destroyMessageKey, zeroize } from "../destruction/destruction.js";
import { canTransition, assertTransition, MessageKeyState } from "../lifecycle/lifecycle.js";
import { MessageKeyCache } from "../cache/messageKeyCache.js";
import { MessageKeyValidationError, MessageKeyDerivationError } from "../errors.js";
import { makeClock } from "./helpers.js";

const context = { sessionId: "session-000001", handshakeId: "hs" };
const chainKey = crypto.createHash("sha256").update("chain").digest();

describe("per-message key derivation", () => {
  it("derives a 32-byte enc + mac key with a unique id per message number", () => {
    const mk0 = deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: 0, context });
    const mk1 = deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: 1, context });
    assert.equal(mk0.encryptionKey.length, 32);
    assert.equal(mk0.macKey.length, 32);
    assert.match(mk0.keyId, /^[0-9a-f]{32}$/);
    assert.notEqual(mk0.keyId, mk1.keyId, "different message number → different key");
    assert.ok(!mk0.encryptionKey.equals(mk1.encryptionKey));
  });

  it("is deterministic: same inputs → same key (sender + receiver agree)", () => {
    const a = deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: 5, context });
    const b = deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: 5, context });
    assert.equal(a.keyId, b.keyId);
    assert.ok(a.encryptionKey.equals(b.encryptionKey));
  });

  it("context separation: direction + generation change the key", () => {
    const base = deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: 0, context });
    const otherDir = deriveMessageKey(chainKey, { direction: "r2i", generation: 0, messageNumber: 0, context });
    const otherGen = deriveMessageKey(chainKey, { direction: "i2r", generation: 1, messageNumber: 0, context });
    assert.notEqual(base.keyId, otherDir.keyId);
    assert.notEqual(base.keyId, otherGen.keyId);
  });

  it("rejects an empty chain key", () => {
    assert.throws(() => deriveMessageKey(Buffer.alloc(0), { direction: "i2r", generation: 0, messageNumber: 0, context }), MessageKeyDerivationError);
  });
});

describe("message key destruction", () => {
  it("zero-fills the key bundle + returns a metadata-only record", () => {
    const mk = deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: 0, context });
    const encCopy = Buffer.from(mk.encryptionKey);
    const rec = destroyMessageKey(mk, { reason: "used", at: "t" });
    assert.ok(mk.encryptionKey.every((b) => b === 0), "encryption key wiped");
    assert.ok(mk.macKey.every((b) => b === 0), "mac key wiped");
    assert.ok(!mk.encryptionKey.equals(encCopy));
    assert.equal(rec.reason, "used");
    assert.ok(rec.keyId, "public keyId retained");
    // no secret material in the record
    assert.equal(JSON.stringify(rec).toLowerCase().includes("encryptionkey"), false);
  });

  it("zeroize is idempotent + tolerant", () => {
    assert.doesNotThrow(() => zeroize(null));
    const b = Buffer.from("x");
    zeroize(b);
    assert.equal(b[0], 0);
  });
});

describe("message key lifecycle", () => {
  it("legal transitions; DESTROYED terminal", () => {
    assert.ok(canTransition(MessageKeyState.DERIVED, MessageKeyState.ACTIVE));
    assert.ok(canTransition(MessageKeyState.ACTIVE, MessageKeyState.USED));
    assert.ok(canTransition(MessageKeyState.USED, MessageKeyState.DESTROYED));
    assert.ok(canTransition(MessageKeyState.DERIVED, MessageKeyState.CACHED));
    assert.ok(!canTransition(MessageKeyState.DESTROYED, MessageKeyState.ACTIVE));
    assert.throws(() => assertTransition(MessageKeyState.USED, MessageKeyState.ACTIVE), MessageKeyValidationError);
  });
});

describe("skipped-key cache", () => {
  it("put/take/has + destroys on eviction over the limit", () => {
    const clock = makeClock();
    const cache = new MessageKeyCache({ clock, limit: 2 });
    const mk = (n) => deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: n, context });
    cache.put("s", "i2r", 0, 0, mk(0));
    cache.put("s", "i2r", 0, 1, mk(1));
    assert.equal(cache.size, 2);
    const evicting = mk(2);
    const { evicted } = cache.put("s", "i2r", 0, 2, evicting); // over limit → oldest destroyed
    assert.ok(evicted, "oldest key destroyed on eviction");
    assert.equal(cache.size, 2);
    assert.ok(cache.has("s", "i2r", 0, 2));
    const taken = cache.take("s", "i2r", 0, 2);
    assert.ok(taken);
    assert.equal(cache.take("s", "i2r", 0, 2), null, "taken once, then gone");
  });

  it("prunes expired keys + destroys per session", () => {
    const clock = makeClock();
    const cache = new MessageKeyCache({ clock, ttlMs: 1000 });
    cache.put("s", "i2r", 0, 0, deriveMessageKey(chainKey, { direction: "i2r", generation: 0, messageNumber: 0, context }));
    clock.advance(1000);
    assert.equal(cache.pruneExpired().length, 1);
    assert.equal(cache.size, 0);
  });
});
