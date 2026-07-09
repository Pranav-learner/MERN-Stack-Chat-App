import { describe, it, expect } from "vitest";
import {
  CryptoError,
  EncryptionError,
  DecryptionError,
  InvalidKeyError,
  InvalidSignatureError,
  InvalidCiphertextError,
  KeyImportError,
  KeyExportError,
  RandomGenerationError,
  EncodingError,
  HashingError,
  KeyDerivationError,
  ValidationError,
} from "../src/index.js";

const cases: Array<[new (m?: string) => CryptoError, string]> = [
  [EncryptionError, "ERR_ENCRYPTION"],
  [DecryptionError, "ERR_DECRYPTION"],
  [InvalidKeyError, "ERR_INVALID_KEY"],
  [InvalidSignatureError, "ERR_INVALID_SIGNATURE"],
  [InvalidCiphertextError, "ERR_INVALID_CIPHERTEXT"],
  [KeyImportError, "ERR_KEY_IMPORT"],
  [KeyExportError, "ERR_KEY_EXPORT"],
  [RandomGenerationError, "ERR_RANDOM_GENERATION"],
  [EncodingError, "ERR_ENCODING"],
  [HashingError, "ERR_HASHING"],
  [KeyDerivationError, "ERR_KEY_DERIVATION"],
  [ValidationError, "ERR_VALIDATION"],
];

describe("errors", () => {
  it("every SDK error extends CryptoError and Error", () => {
    for (const [Ctor] of cases) {
      const e = new Ctor("boom");
      expect(e).toBeInstanceOf(CryptoError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("each error carries its stable code and class name", () => {
    for (const [Ctor, code] of cases) {
      const e = new Ctor("boom");
      expect(e.code).toBe(code);
      expect(e.name).toBe(Ctor.name);
      expect(e.message).toBe("boom");
    }
  });

  it("preserves the underlying cause", () => {
    const root = new Error("root");
    const e = new DecryptionError("failed", { cause: root });
    expect(e.cause).toBe(root);
  });

  it("base CryptoError has a default code", () => {
    expect(new CryptoError("x").code).toBe("ERR_CRYPTO");
  });

  it("errors have usable stack traces", () => {
    expect(new EncryptionError("x").stack).toContain("EncryptionError");
  });
});
