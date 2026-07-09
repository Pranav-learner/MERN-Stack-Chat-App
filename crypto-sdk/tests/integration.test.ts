import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  generateSigningKeyPair,
  deriveSharedSecret,
  sign,
  verify,
  encrypt,
  decrypt,
  bytesToUtf8,
  utf8ToBytes,
  randomBytes,
  sha256,
  EncryptedPayload,
  Signature,
} from "../src/index.js";

/**
 * End-to-end demonstration of how future modules will compose these primitives.
 * This exercises the full "handshake -> derive -> authenticated encrypt -> sign
 * -> transmit as bytes -> verify -> decrypt" pipeline WITHOUT any chat/transport.
 */
describe("integration: full crypto pipeline", () => {
  it("Alice -> Bob: agree, derive, sign, encrypt, serialize, verify, decrypt", () => {
    // Long-term signing identities (Ed25519).
    const aliceId = generateSigningKeyPair();
    const bobId = generateSigningKeyPair();

    // Ephemeral agreement keys (X25519).
    const aliceEph = generateKeyPair();
    const bobEph = generateKeyPair();

    // Each side computes the same shared secret and derives the same message key.
    const info = "securechat:demo:v1";
    const aliceKey = deriveSharedSecret(aliceEph.privateKey, bobEph.publicKey).deriveKey({ info });
    const bobKey = deriveSharedSecret(bobEph.privateKey, aliceEph.publicKey).deriveKey({ info });

    // Alice encrypts a message and binds context via AAD, then signs the ciphertext.
    const aad = utf8ToBytes("from:alice|to:bob|seq:1");
    const payload = encrypt(aliceKey, "meet at 8", { aad });
    const wire = payload.serialize();
    const sig = sign(aliceId.privateKey, wire);

    // ---- transmit `wire` + `sig.toBase64()` as opaque bytes/strings ----

    // Bob verifies authenticity, then decrypts.
    const receivedSig = Signature.fromBase64(sig.toBase64());
    expect(verify(aliceId.publicKey, wire, receivedSig)).toBe(true);

    const received = EncryptedPayload.deserialize(wire);
    const plaintext = decrypt(bobKey, received, { aad });
    expect(bytesToUtf8(plaintext)).toBe("meet at 8");

    // A forged sender identity is rejected.
    expect(verify(bobId.publicKey, wire, receivedSig)).toBe(false);
  });

  it("large binary media blob survives the pipeline with an integrity digest", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const key = deriveSharedSecret(alice.privateKey, bob.publicKey).deriveKey({ info: "media" });

    const blob = randomBytes(512 * 1024);
    const digestBefore = sha256(blob);

    const payload = encrypt(key, blob);
    const restored = decrypt(
      deriveSharedSecret(bob.privateKey, alice.publicKey).deriveKey({ info: "media" }),
      payload,
    );

    expect(restored).toEqual(blob);
    expect(sha256(restored)).toEqual(digestBefore);
  });
});
