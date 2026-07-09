import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateDeviceSubmission,
  validateCapabilities,
  validateMetadata,
} from "../validators/deviceValidators.js";
import { DeviceValidationError } from "../errors.js";
import { makeDeviceSubmission } from "./helpers.js";

describe("device validators", () => {
  it("accepts a well-formed submission and returns 32 key bytes", () => {
    const bytes = validateDeviceSubmission(makeDeviceSubmission());
    assert.equal(bytes.length, 32);
  });

  it("rejects a short deviceId", () => {
    assert.throws(() => validateDeviceSubmission(makeDeviceSubmission({ deviceId: "short" })), DeviceValidationError);
  });

  it("rejects fingerprint/key mismatch (reused Sprint 1 check, rewrapped)", () => {
    assert.throws(
      () => validateDeviceSubmission(makeDeviceSubmission({ fingerprint: "0".repeat(64) })),
      DeviceValidationError,
    );
  });

  it("rejects unknown capabilities and non-string descriptors", () => {
    assert.throws(() => validateDeviceSubmission(makeDeviceSubmission({ capabilities: ["mining"] })), DeviceValidationError);
    assert.throws(() => validateDeviceSubmission(makeDeviceSubmission({ os: 123 })), DeviceValidationError);
  });

  it("validateCapabilities / validateMetadata standalone", () => {
    assert.doesNotThrow(() => validateCapabilities(["messaging", "media"]));
    assert.throws(() => validateCapabilities("nope"), DeviceValidationError);
    assert.doesNotThrow(() => validateMetadata({ a: 1 }));
    assert.throws(() => validateMetadata([1, 2]), DeviceValidationError);
  });
});
