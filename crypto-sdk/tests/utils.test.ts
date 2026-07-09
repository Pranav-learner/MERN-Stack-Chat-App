import { describe, it, expect } from "vitest";
import {
  constantTimeEqual,
  coerceToBytes,
  wipe,
  cloneBytes,
  isUint8Array,
  assertUint8Array,
  assertLength,
  assertNonEmpty,
  assertInteger,
  ValidationError,
} from "../src/index.js";

describe("utils", () => {
  describe("constantTimeEqual", () => {
    it("returns true for equal buffers", () => {
      expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    });
    it("returns false for differing buffers of equal length", () => {
      expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    });
    it("returns false for length mismatch (no throw)", () => {
      expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    });
    it("throws on non-bytes", () => {
      // @ts-expect-error runtime guard
      expect(() => constantTimeEqual("a", "a")).toThrow(ValidationError);
    });
  });

  describe("coerceToBytes", () => {
    it("passes through Uint8Array", () => {
      const b = new Uint8Array([1, 2]);
      expect(coerceToBytes(b)).toBe(b);
    });
    it("encodes strings as UTF-8", () => {
      expect([...coerceToBytes("hi")]).toEqual([104, 105]);
    });
    it("throws on invalid input", () => {
      // @ts-expect-error runtime guard
      expect(() => coerceToBytes(123)).toThrow(ValidationError);
    });
  });

  it("wipe zeroes bytes in place", () => {
    const b = new Uint8Array([1, 2, 3]);
    wipe(b);
    expect([...b]).toEqual([0, 0, 0]);
  });

  it("cloneBytes returns an independent copy", () => {
    const b = new Uint8Array([1, 2, 3]);
    const c = cloneBytes(b);
    c[0] = 9;
    expect(b[0]).toBe(1);
  });

  it("type guards / assertions behave", () => {
    expect(isUint8Array(new Uint8Array())).toBe(true);
    expect(isUint8Array([])).toBe(false);
    expect(() => assertUint8Array(5)).toThrow(ValidationError);
    expect(() => assertLength(new Uint8Array(3), 4)).toThrow(ValidationError);
    expect(() => assertNonEmpty(new Uint8Array(0))).toThrow(ValidationError);
    expect(() => assertInteger(1.2)).toThrow(ValidationError);
    expect(() => assertInteger(5, "n", { min: 10 })).toThrow(ValidationError);
  });
});
