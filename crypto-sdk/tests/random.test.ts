import { describe, it, expect } from "vitest";
import {
  randomBytes,
  generateNonce,
  generateIV,
  randomId,
  randomHexId,
  uuid,
  randomInt,
  ValidationError,
  GCM_NONCE_BYTES,
} from "../src/index.js";

describe("random", () => {
  it("generates the requested number of bytes", () => {
    expect(randomBytes(1)).toHaveLength(1);
    expect(randomBytes(32)).toHaveLength(32);
    expect(randomBytes(1024)).toHaveLength(1024);
  });

  it("does not repeat (astronomically unlikely)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(Buffer.from(randomBytes(16)).toString("hex"));
    }
    expect(seen.size).toBe(1000);
  });

  it("nonce/IV default to the GCM size", () => {
    expect(generateNonce()).toHaveLength(GCM_NONCE_BYTES);
    expect(generateIV()).toHaveLength(GCM_NONCE_BYTES);
    expect(generateNonce(24)).toHaveLength(24);
  });

  it("randomId / randomHexId have expected shapes", () => {
    expect(randomId(16)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomHexId(16)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uuid is a valid v4 UUID", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("randomInt stays within [min, max)", () => {
    for (let i = 0; i < 500; i++) {
      const n = randomInt(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThan(10);
    }
  });

  it("rejects invalid inputs", () => {
    expect(() => randomBytes(0)).toThrow(ValidationError);
    expect(() => randomBytes(-1)).toThrow(ValidationError);
    expect(() => randomBytes(1.5)).toThrow(ValidationError);
    expect(() => randomBytes(2 ** 40)).toThrow(ValidationError);
    expect(() => randomInt(10, 5)).toThrow(ValidationError);
  });
});
