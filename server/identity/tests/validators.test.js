import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodePublicKey,
  assertValidEd25519PublicKey,
  validatePublicKeySubmission,
  validateDeviceDescriptor,
} from "../validators/identityValidators.js";
import { IdentityValidationError } from "../errors.js";
import { makeIdentityKey } from "./helpers.js";

describe("validators", () => {
  it("decodePublicKey accepts a 32-byte base64 key and rejects bad input", () => {
    const { publicKey, raw } = makeIdentityKey();
    assert.deepEqual(decodePublicKey(publicKey), raw);
    assert.throws(() => decodePublicKey("not base64 !!!"), IdentityValidationError);
    assert.throws(() => decodePublicKey(Buffer.from("short").toString("base64")), IdentityValidationError);
    assert.throws(() => decodePublicKey(""), IdentityValidationError);
  });

  it("assertValidEd25519PublicKey accepts a real key", () => {
    const { raw } = makeIdentityKey();
    assert.doesNotThrow(() => assertValidEd25519PublicKey(raw));
  });

  it("validatePublicKeySubmission accepts a consistent submission", () => {
    const k = makeIdentityKey();
    const bytes = validatePublicKeySubmission(k);
    assert.deepEqual(bytes, k.raw);
  });

  it("rejects unsupported algorithm", () => {
    const k = makeIdentityKey();
    assert.throws(
      () => validatePublicKeySubmission({ ...k, algorithm: "rsa" }),
      IdentityValidationError,
    );
  });

  it("rejects fingerprint that does not match the key", () => {
    const k = makeIdentityKey();
    assert.throws(
      () => validatePublicKeySubmission({ ...k, fingerprint: "0".repeat(64) }),
      IdentityValidationError,
    );
  });

  it("rejects a corrupted (wrong-length) public key", () => {
    const k = makeIdentityKey();
    const corrupted = Buffer.from(k.raw.subarray(0, 16)).toString("base64");
    assert.throws(
      () => validatePublicKeySubmission({ ...k, publicKey: corrupted }),
      IdentityValidationError,
    );
  });

  it("validateDeviceDescriptor enforces a stable deviceId and string fields", () => {
    assert.doesNotThrow(() => validateDeviceDescriptor({ deviceId: "device-abcdefgh" }));
    assert.throws(() => validateDeviceDescriptor({ deviceId: "short" }), IdentityValidationError);
    assert.throws(() => validateDeviceDescriptor({}), IdentityValidationError);
    assert.throws(
      () => validateDeviceDescriptor({ deviceId: "device-abcdefgh", name: 123 }),
      IdentityValidationError,
    );
  });
});
