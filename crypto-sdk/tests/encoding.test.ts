import { describe, it, expect } from "vitest";
import {
  utf8ToBytes,
  bytesToUtf8,
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  toHex,
  fromHex,
  EncodingError,
} from "../src/index.js";

describe("encoding", () => {
  it("round-trips UTF-8 (including multibyte)", () => {
    for (const s of ["", "hello", "héllo wörld", "日本語 😀 🔐", "a".repeat(1000)]) {
      expect(bytesToUtf8(utf8ToBytes(s))).toBe(s);
    }
  });

  it("round-trips base64 / base64url / hex", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    expect([...fromHex(toHex(bytes))]).toEqual([...bytes]);
  });

  it("produces url-safe base64url without padding", () => {
    const bytes = new Uint8Array([251, 255, 191]); // yields + and / in std base64
    const b64url = toBase64Url(bytes);
    expect(b64url).not.toMatch(/[+/=]/);
  });

  it("matches known SHA-256-of-empty vectors across encodings", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(toHex(bytes)).toBe("deadbeef");
    expect(toBase64(bytes)).toBe("3q2+7w==");
    expect(toBase64Url(bytes)).toBe("3q2-7w");
  });

  it("rejects malformed hex", () => {
    expect(() => fromHex("xyz")).toThrow(EncodingError);
    expect(() => fromHex("abc")).toThrow(EncodingError); // odd length
  });

  it("rejects malformed base64 / base64url", () => {
    expect(() => fromBase64("!!!!")).toThrow(EncodingError);
    expect(() => fromBase64Url("has space")).toThrow(EncodingError);
  });

  it("rejects wrong argument types", () => {
    // @ts-expect-error runtime guard test
    expect(() => toHex("not bytes")).toThrow(EncodingError);
    // @ts-expect-error runtime guard test
    expect(() => utf8ToBytes(123)).toThrow(EncodingError);
  });
});
