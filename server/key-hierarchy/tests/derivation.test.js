import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRootKey,
  deriveChainKey,
  advanceChainKey,
  keyFingerprint,
  keyId,
  directionsForRole,
  messageKeyLabel,
  disposeKey,
} from "../derivation/derivation.js";
import { ChainDirection, DeviceRole } from "../types/types.js";
import { KeyHierarchyDerivationError } from "../errors.js";
import { makeSecret } from "./helpers.js";

const ctx = { sessionId: "session-000001", handshakeId: "hs-1", generation: 0 };

describe("key-hierarchy derivation", () => {
  it("root key: deterministic, 32 bytes, generation-bound", () => {
    const rootA = deriveRootKey(makeSecret(1), ctx);
    const rootB = deriveRootKey(makeSecret(1), ctx);
    assert.equal(rootA.length, 32);
    assert.ok(rootA.equals(rootB), "both peers derive the same root key");
    const rootGen1 = deriveRootKey(makeSecret(1), { ...ctx, generation: 1 });
    assert.ok(!rootA.equals(rootGen1), "different generation → different root");
  });

  it("sending + receiving chains are independent (distinct keys)", () => {
    const root = deriveRootKey(makeSecret(2), ctx);
    const i2r = deriveChainKey(root, ChainDirection.I2R, ctx);
    const r2i = deriveChainKey(root, ChainDirection.R2I, ctx);
    assert.ok(!i2r.equals(r2i), "the two direction chains differ");
    assert.equal(i2r.length, 32);
  });

  it("peer-symmetric directions: my sending == peer's receiving", () => {
    const root = deriveRootKey(makeSecret(3), ctx);
    const initiator = directionsForRole(DeviceRole.INITIATOR);
    const responder = directionsForRole(DeviceRole.RESPONDER);
    assert.equal(initiator.sending, ChainDirection.I2R);
    assert.equal(responder.receiving, ChainDirection.I2R);
    // initiator's sending chain key == responder's receiving chain key
    const initSending = deriveChainKey(root, initiator.sending, ctx);
    const respReceiving = deriveChainKey(root, responder.receiving, ctx);
    assert.ok(initSending.equals(respReceiving), "interop: A.sending == B.receiving");
  });

  it("chain advancement is one-way + produces distinct keys per index", () => {
    let ck = deriveChainKey(deriveRootKey(makeSecret(4), ctx), ChainDirection.I2R, ctx);
    const seen = new Set([ck.toString("hex")]);
    let prev = ck;
    for (let i = 1; i <= 5; i++) {
      ck = advanceChainKey(prev, ctx, i);
      assert.equal(ck.length, 32);
      assert.ok(!ck.equals(prev), "advanced key differs from its parent");
      seen.add(ck.toString("hex"));
      prev = ck;
    }
    assert.equal(seen.size, 6, "six distinct chain keys");
  });

  it("fingerprint + keyId are public, stable, distinct per position", () => {
    const ck = deriveChainKey(deriveRootKey(makeSecret(5), ctx), ChainDirection.I2R, ctx);
    assert.match(keyFingerprint(ck), /^[0-9a-f]{64}$/);
    assert.equal(keyId(ck, "i2r", 0).length, 32);
    assert.notEqual(keyId(ck, "i2r", 0), keyId(ck, "i2r", 1));
  });

  it("messageKeyLabel is a distinct extension-point label (no derivation performed)", () => {
    const l0 = messageKeyLabel(0).toString("utf8");
    const l1 = messageKeyLabel(1).toString("utf8");
    assert.match(l0, /message-key\|index=0/);
    assert.notEqual(l0, l1);
  });

  it("rejects empty secrets; disposeKey zero-fills", () => {
    assert.throws(() => deriveRootKey(Buffer.alloc(0), ctx), KeyHierarchyDerivationError);
    assert.throws(() => deriveChainKey(Buffer.alloc(0), ChainDirection.I2R, ctx), KeyHierarchyDerivationError);
    assert.throws(() => advanceChainKey(Buffer.alloc(0), ctx, 1), KeyHierarchyDerivationError);
    const k = makeSecret(9);
    disposeKey(k);
    assert.ok(k.every((b) => b === 0));
  });
});
