import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { seedChain, evolveChain, deriveGenerationKeys, disposeChainSecret } from "../derivation/keyChain.js";
import {
  zeroize,
  buildDestructionRecord,
  destroyGenerationKeys,
  destroyChainSecret,
  destroyIntermediateMaterial,
} from "../destruction/secureDestruction.js";
import { ChainDerivationError } from "../errors.js";
import { makeSecret } from "./helpers.js";

const ctx = { sessionId: "session-000001", handshakeId: "hs-1" };
const sessionCtx = { handshakeId: "hs-1", participants: ["alice", "bob"], protocolVersion: "1.0" };

describe("forward-secrecy chain — derivation", () => {
  it("seeds deterministically and is one-way (chain_{n+1} != chain_n)", () => {
    const root = makeSecret(1);
    const c0a = seedChain(root, ctx);
    const c0b = seedChain(root, ctx);
    assert.ok(c0a.equals(c0b), "seeding is deterministic (both peers agree)");
    const c1 = evolveChain(c0a, 1, ctx);
    assert.equal(c1.length, 32);
    assert.ok(!c1.equals(c0a), "evolved chain differs from its parent");
  });

  it("two peers derive identical generation keys from the same root", () => {
    const root = makeSecret(7);
    const peerA = seedChain(root, ctx);
    const peerB = seedChain(root, ctx);
    const kA = deriveGenerationKeys(peerA, sessionCtx, 0);
    const kB = deriveGenerationKeys(peerB, sessionCtx, 0);
    assert.equal(kA.keyId, kB.keyId);
    assert.equal(kA.keyFingerprint, kB.keyFingerprint);
    assert.ok(kA.encryptionKey.equals(kB.encryptionKey));
  });

  it("each generation produces distinct keys + keyIds", () => {
    const root = makeSecret(3);
    let chain = seedChain(root, ctx);
    const seen = new Set();
    const keyIds = new Set();
    for (let gen = 0; gen <= 5; gen++) {
      const keys = deriveGenerationKeys(chain, sessionCtx, gen);
      seen.add(keys.encryptionKey.toString("hex"));
      keyIds.add(keys.keyId);
      if (gen < 5) chain = evolveChain(chain, gen + 1, ctx);
    }
    assert.equal(seen.size, 6, "all six generations have distinct encryption keys");
    assert.equal(keyIds.size, 6, "all six generations have distinct keyIds");
  });

  it("compromising chain_n cannot recover chain_{n-1} (forward secrecy at the KDF level)", () => {
    // The one-wayness of HKDF/SHA-256 is what guarantees this; we assert the values are
    // unrelated (a leaked later chain reveals nothing byte-wise about the earlier one).
    const root = makeSecret(9);
    const c0 = seedChain(root, ctx);
    const c1 = evolveChain(c0, 1, ctx);
    const c2 = evolveChain(c1, 2, ctx);
    assert.ok(!c2.equals(c1) && !c2.equals(c0));
    // knowing c2, the only way back to c1 would be to invert HKDF — infeasible.
    assert.notEqual(crypto.createHash("sha256").update(c2).digest("hex"), crypto.createHash("sha256").update(c1).digest("hex"));
  });

  it("rejects empty root / chain secrets", () => {
    assert.throws(() => seedChain(Buffer.alloc(0), ctx), ChainDerivationError);
    assert.throws(() => evolveChain(Buffer.alloc(0), 1, ctx), ChainDerivationError);
    assert.throws(() => deriveGenerationKeys(Buffer.alloc(0), sessionCtx, 0), ChainDerivationError);
  });
});

describe("forward-secrecy — secure destruction", () => {
  it("zeroize wipes a buffer; disposeChainSecret is idempotent", () => {
    const buf = Buffer.from("secret-bytes-here-1234567890abcd");
    zeroize(buf);
    assert.ok(buf.every((b) => b === 0));
    assert.doesNotThrow(() => disposeChainSecret(null));
  });

  it("destroyGenerationKeys wipes the keys and returns a metadata-only record", () => {
    const keys = deriveGenerationKeys(seedChain(makeSecret(2), ctx), sessionCtx, 0);
    const encCopy = Buffer.from(keys.encryptionKey);
    const rec = destroyGenerationKeys(keys, { generation: 0, at: "t" });
    assert.equal(rec.scope, "generation-keys");
    assert.equal(rec.generation, 0);
    assert.ok(rec.keyId, "keyId retained (public)");
    assert.ok(keys.encryptionKey.every((b) => b === 0), "encryption key wiped");
    assert.ok(!keys.encryptionKey.equals(encCopy));
    // the destruction record carries NO secret material
    assert.equal(JSON.stringify(rec).toLowerCase().includes("encryptionkey"), false);
    assert.equal(JSON.stringify(rec).includes("bytes"), false);
  });

  it("destroyChainSecret + destroyIntermediateMaterial wipe and record", () => {
    const chain = seedChain(makeSecret(4), ctx);
    const rec = destroyChainSecret(chain, { generation: 1, at: "t" });
    assert.equal(rec.scope, "chain-secret");
    assert.ok(chain.every((b) => b === 0));

    const keys = deriveGenerationKeys(seedChain(makeSecret(5), ctx), sessionCtx, 1);
    const inter = destroyIntermediateMaterial({ chainSecret: Buffer.from("abc"), keys, generation: 2 });
    assert.equal(inter.scope, "intermediate");
    assert.equal(inter.reason, "failed-evolution");
    assert.ok(keys.macKey.every((b) => b === 0));
  });

  it("buildDestructionRecord never includes key bytes", () => {
    const rec = buildDestructionRecord({ scope: "generation-keys", generation: 3, keyId: "abc", fingerprint: "fp", reason: "superseded" });
    assert.deepEqual(Object.keys(rec).sort(), ["at", "fingerprint", "generation", "keyId", "reason", "scope"]);
  });
});
