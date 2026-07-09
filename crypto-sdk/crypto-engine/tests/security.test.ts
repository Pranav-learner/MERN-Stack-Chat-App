import { describe, it, expect } from "vitest";
import { randomBytes, ValidationError } from "@securechat/crypto-sdk";
import {
  SecureBuffer,
  analyzeRandomness,
  assertRandomness,
  toBytes,
  assertBinary,
  constantTimeEqual,
} from "../src/index.js";

describe("SecureBuffer", () => {
  it("copies input and returns copies", () => {
    const src = new Uint8Array([1, 2, 3]);
    const buf = new SecureBuffer(src);
    src[0] = 9;
    expect(buf.bytes[0]).toBe(1); // independent of source
    const out = buf.bytes;
    out[0] = 8;
    expect(buf.bytes[0]).toBe(1); // independent of returned copy
  });

  it("wipes and blocks access afterwards", () => {
    const buf = new SecureBuffer(new Uint8Array([1, 2, 3]));
    buf.wipe();
    expect(buf.isWiped).toBe(true);
    expect(() => buf.bytes).toThrow(ValidationError);
  });

  it("auto-wipes via Symbol.dispose", () => {
    const buf = new SecureBuffer(new Uint8Array([1, 2, 3]));
    buf[Symbol.dispose]();
    expect(buf.isWiped).toBe(true);
  });

  it("alloc creates a zeroed buffer; does not leak via JSON", () => {
    const buf = SecureBuffer.alloc(4);
    expect([...buf.bytes]).toEqual([0, 0, 0, 0]);
    expect(JSON.stringify({ k: buf })).toBe(`{"k":"[SecureBuffer]"}`);
  });
});

describe("randomness sanity", () => {
  it("accepts CSPRNG output", () => {
    const report = analyzeRandomness(randomBytes(256));
    expect(report.ok).toBe(true);
    expect(report.entropyBitsPerByte).toBeGreaterThan(7);
    expect(() => assertRandomness(randomBytes(64))).not.toThrow();
  });

  it("rejects too-short, all-identical, and low-entropy data", () => {
    expect(analyzeRandomness(new Uint8Array(4)).ok).toBe(false); // too short
    expect(analyzeRandomness(new Uint8Array(64).fill(7)).ok).toBe(false); // identical
    const lowEntropy = new Uint8Array(256);
    for (let i = 0; i < lowEntropy.length; i++) lowEntropy[i] = i % 2; // 1 bit/byte
    expect(analyzeRandomness(lowEntropy).ok).toBe(false);
    expect(() => assertRandomness(new Uint8Array(4))).toThrow(ValidationError);
  });
});

describe("binary validation", () => {
  it("toBytes coerces typed arrays / ArrayBuffer", () => {
    expect([...toBytes(new Uint8Array([1, 2]))]).toEqual([1, 2]);
    expect(toBytes(new ArrayBuffer(3))).toHaveLength(3);
    const view = new Uint16Array([1]);
    expect(toBytes(view)).toHaveLength(2);
    // @ts-expect-error runtime guard
    expect(() => toBytes("nope")).toThrow(ValidationError);
  });

  it("assertBinary enforces type and max length", () => {
    expect(() => assertBinary(new Uint8Array(5), 4)).toThrow(ValidationError);
    expect(() => assertBinary("x" as unknown)).toThrow(ValidationError);
  });

  it("re-exports constant-time equality", () => {
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1]))).toBe(true);
  });
});
