import { describe, it, expect } from "vitest";
import {
  KeyValidator,
  KeyValidationError,
  KeyExpiredError,
  KeyStatus,
  toIso,
} from "../src/index.js";
import { makeIdentityKey } from "./helpers.js";

const validator = new KeyValidator();

describe("validators", () => {
  it("accepts a well-formed key", () => {
    expect(() => validator.validateManagedKey(makeIdentityKey())).not.toThrow();
  });

  it("rejects invalid metadata fields", () => {
    const key = makeIdentityKey();
    expect(() => validator.validateMetadata({ ...key.metadata, keyId: "" })).toThrow(
      KeyValidationError,
    );
    expect(() => validator.validateMetadata({ ...key.metadata, version: 0 })).toThrow(
      KeyValidationError,
    );
    expect(() => validator.validateMetadata({ ...key.metadata, rotationCount: -1 })).toThrow(
      KeyValidationError,
    );
    // @ts-expect-error invalid enum at runtime
    expect(() => validator.validateMetadata({ ...key.metadata, type: "nope" })).toThrow(
      KeyValidationError,
    );
    // @ts-expect-error invalid enum at runtime
    expect(() => validator.validateMetadata({ ...key.metadata, status: "nope" })).toThrow(
      KeyValidationError,
    );
    expect(() => validator.validateMetadata({ ...key.metadata, createdAt: "not-a-date" })).toThrow(
      KeyValidationError,
    );
    expect(() => validator.validateMetadata({ ...key.metadata, fingerprint: "" })).toThrow(
      KeyValidationError,
    );
  });

  it("detects a fingerprint / material mismatch (corruption)", () => {
    const key = makeIdentityKey();
    const corrupted = key.withMetadata({ fingerprint: "0".repeat(64) });
    expect(() => validator.validateFingerprint(corrupted)).toThrow(KeyValidationError);
    expect(() => validator.validateManagedKey(corrupted)).toThrow(KeyValidationError);
  });

  it("can skip the fingerprint check", () => {
    const corrupted = makeIdentityKey().withMetadata({ fingerprint: "0".repeat(64) });
    expect(() =>
      validator.validateManagedKey(corrupted, { checkFingerprint: false }),
    ).not.toThrow();
  });

  it("enforces expiry when asked", () => {
    const key = makeIdentityKey().withMetadata({
      expiresAt: toIso(1000),
      status: KeyStatus.ACTIVE,
    });
    expect(() => validator.validateNotExpired(key.metadata, 999)).not.toThrow();
    expect(() => validator.validateNotExpired(key.metadata, 1001)).toThrow(KeyExpiredError);
    expect(() => validator.validateManagedKey(key, { checkExpiry: true, now: 2000 })).toThrow(
      KeyExpiredError,
    );
  });

  it("rejects non-ManagedKey inputs", () => {
    // @ts-expect-error runtime guard
    expect(() => validator.validateManagedKey({})).toThrow(KeyValidationError);
  });
});
