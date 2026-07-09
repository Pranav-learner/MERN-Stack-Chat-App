import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hash,
  sha256,
  sha512,
  blake2b512,
  hashHex,
  hashFile,
  HashAlgorithm,
  HashingError,
} from "../src/index.js";

describe("hashing", () => {
  // Known-answer tests (NIST / RFC vectors).
  it("SHA-256('abc') matches the known vector", () => {
    expect(hashHex("abc", HashAlgorithm.SHA256)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("SHA-256('') matches the known vector", () => {
    expect(hashHex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("SHA-512('abc') matches the known vector", () => {
    expect(hashHex("abc", HashAlgorithm.SHA512)).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("produces correct digest lengths", () => {
    expect(sha256("x")).toHaveLength(32);
    expect(sha512("x")).toHaveLength(64);
    expect(blake2b512("x")).toHaveLength(64);
  });

  it("is deterministic and collision-sensitive", () => {
    expect(sha256("hello")).toEqual(sha256("hello"));
    expect(sha256("hello")).not.toEqual(sha256("hellp"));
  });

  it("accepts binary buffers and strings equivalently", () => {
    expect(sha256(new Uint8Array([104, 105]))).toEqual(sha256("hi"));
  });

  describe("hashFile", () => {
    const path = join(tmpdir(), `crypto-sdk-hashfile-${process.pid}.bin`);
    beforeAll(async () => {
      await writeFile(path, Buffer.from("abc"));
    });
    afterAll(async () => {
      await rm(path, { force: true });
    });

    it("hashes file contents identically to hashing the bytes", async () => {
      const fromFile = await hashFile(path, HashAlgorithm.SHA256);
      expect(Buffer.from(fromFile).toString("hex")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    });

    it("rejects a missing file", async () => {
      await expect(hashFile(join(tmpdir(), "does-not-exist.xyz"))).rejects.toBeInstanceOf(
        HashingError,
      );
    });
  });

  it("wraps failures in HashingError", () => {
    // @ts-expect-error invalid algorithm at runtime
    expect(() => hash("x", "not-a-real-hash")).toThrow(HashingError);
  });
});
