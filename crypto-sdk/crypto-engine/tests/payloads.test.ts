import { describe, it, expect } from "vitest";
import { SymmetricKey, encrypt, generateSigningKeyPair, sign } from "@securechat/crypto-sdk";
import {
  EncryptedBuffer,
  SignedPayload,
  EncryptedFile,
  EncryptedAttachment,
  PayloadError,
  fingerprint,
} from "../src/index.js";

describe("payload models", () => {
  it("EncryptedBuffer round-trips and rejects bad input", () => {
    const payload = encrypt(SymmetricKey.generate(), "hi");
    const buf = new EncryptedBuffer(payload, { contentType: "text/plain" });
    const restored = EncryptedBuffer.deserialize(buf.serialize());
    expect(restored.metadata.contentType).toBe("text/plain");
    expect(restored.ciphertext).toEqual(payload.ciphertext);
    expect(() => EncryptedBuffer.deserialize("not json")).toThrow(PayloadError);
    expect(() => EncryptedBuffer.deserialize(JSON.stringify({ format: "x" }))).toThrow(
      PayloadError,
    );
  });

  it("SignedPayload serializes attached and detached forms", () => {
    const kp = generateSigningKeyPair();
    const sig = sign(kp.privateKey, "m");
    const metadata = {
      version: 1,
      algorithm: "ed25519" as const,
      signerFingerprint: fingerprint(kp.publicKey),
      createdAt: new Date(0).toISOString(),
    };
    const attached = new SignedPayload(sig, metadata, new TextEncoder().encode("m"));
    expect(SignedPayload.deserialize(attached.serialize()).isDetached).toBe(false);
    const detached = new SignedPayload(sig, metadata);
    expect(SignedPayload.deserialize(detached.serialize()).isDetached).toBe(true);
  });

  it("EncryptedFile / EncryptedAttachment reject malformed headers", () => {
    expect(() =>
      EncryptedFile.deserialize(JSON.stringify({ header: { format: "x" }, chunks: [] })),
    ).toThrow(PayloadError);
    const goodHeader = {
      format: "securechat-encrypted-file" as const,
      version: 1,
      algorithm: "AES-256-GCM",
      streamSalt: "AAAA",
      chunkSize: 64,
      metadata: { contentType: "image/png" },
    };
    const att = EncryptedAttachment.fromJSON({ header: goodHeader, chunks: [] });
    expect(att.contentType).toBe("image/png");
    expect(att).toBeInstanceOf(EncryptedAttachment);
  });
});
