import { describe, it, expect } from "vitest";
import {
  KeyManagementError,
  KeyNotFoundError,
  DuplicateKeyError,
  KeyValidationError,
  KeyExpiredError,
  StorageFailureError,
  SerializationError,
  ImportError,
  ExportError,
  RotationError,
  RecoveryError,
  UnsupportedVersionError,
  MigrationError,
} from "../src/index.js";

const cases: Array<[new (m?: string) => KeyManagementError, string]> = [
  [KeyNotFoundError, "ERR_KEY_NOT_FOUND"],
  [DuplicateKeyError, "ERR_DUPLICATE_KEY"],
  [KeyValidationError, "ERR_KEY_VALIDATION"],
  [KeyExpiredError, "ERR_KEY_EXPIRED"],
  [StorageFailureError, "ERR_STORAGE_FAILURE"],
  [SerializationError, "ERR_SERIALIZATION"],
  [ImportError, "ERR_IMPORT"],
  [ExportError, "ERR_EXPORT"],
  [RotationError, "ERR_ROTATION"],
  [RecoveryError, "ERR_RECOVERY"],
  [UnsupportedVersionError, "ERR_UNSUPPORTED_VERSION"],
  [MigrationError, "ERR_MIGRATION"],
];

describe("errors", () => {
  it("all extend KeyManagementError and Error with stable codes", () => {
    for (const [Ctor, code] of cases) {
      const e = new Ctor("boom");
      expect(e).toBeInstanceOf(KeyManagementError);
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe(code);
      expect(e.name).toBe(Ctor.name);
      expect(e.message).toBe("boom");
    }
  });

  it("carries cause and details", () => {
    const cause = new Error("root");
    const e = new StorageFailureError("failed", { cause, details: { keyId: "x" } });
    expect(e.cause).toBe(cause);
    expect(e.details).toEqual({ keyId: "x" });
  });

  it("base default code", () => {
    expect(new KeyManagementError("x").code).toBe("ERR_KEY_MANAGEMENT");
  });
});
