// Runnable copies of the documented examples (CRYPTO_SDK.md §11).
// Validates that the built packages work end-to-end. Exits non-zero on failure.
// Prereq: all three packages built (`npm run build` in each).
import assert from "node:assert/strict";

import {
  generateKeyPair,
  deriveSharedSecret,
  encrypt,
  decrypt,
  bytesToUtf8,
  generateSigningKeyPair,
} from "../dist/index.js";
import { KeyManager } from "../key-management/dist/index.js";
import { FileEncryptor, SignatureEngine, KeyDerivation } from "../crypto-engine/dist/index.js";

// 1. Primitives (Sprint 1)
{
  const a = generateKeyPair();
  const b = generateKeyPair();
  const key = deriveSharedSecret(a.privateKey, b.publicKey).deriveKey({ info: "demo" });
  assert.equal(bytesToUtf8(decrypt(key, encrypt(key, "hello"))), "hello");
  console.log("✓ primitives: agree → derive → encrypt → decrypt");
}

// 2. Key management (Sprint 2)
{
  const km = new KeyManager();
  const id = await km.generateIdentityKey({ owner: "user-1" });
  const { current } = await km.rotateKey(id.keyId);
  assert.equal(current.metadata.version, 2);
  assert.equal(current.metadata.previousKeyId, id.keyId);
  const history = await km.getHistory(current.keyId);
  assert.deepEqual(
    history.map((h) => h.version),
    [1, 2],
  );
  console.log("✓ key-management: generate identity → rotate → history");
}

// 3. Engine (Sprint 3)
{
  const fkey = KeyDerivation.random().deriveSessionKey("peer-42");
  const enc = new FileEncryptor().encryptBuffer(new Uint8Array([1, 2, 3]), fkey);
  const back = new FileEncryptor().decryptBuffer(enc, fkey);
  assert.deepEqual([...back], [1, 2, 3]);

  const kp = generateSigningKeyPair();
  const se = new SignatureEngine();
  const sig = se.signDetached(kp.privateKey, enc.serialize());
  assert.equal(se.verifyPayload(kp.publicKey, sig, enc.serialize()), true);
  console.log("✓ engine: derive key → file encrypt/decrypt → detached sign/verify");
}

console.log("\nAll documented examples ran successfully.");
