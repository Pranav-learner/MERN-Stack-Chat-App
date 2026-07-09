import { describe, it, expect } from "vitest";
import { SymmetricKey, randomBytes } from "@securechat/crypto-sdk";
import {
  FileEncryptor,
  EncryptedFile,
  EncryptedAttachment,
  FileEncryptionError,
  StreamError,
  type EncryptedStreamFrame,
} from "../src/index.js";

const key = SymmetricKey.generate();

/** Build `n` bytes (0-safe; SDK randomBytes requires n >= 1). */
const mk = (n: number): Uint8Array => (n === 0 ? new Uint8Array(0) : randomBytes(n));

async function* fromChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("FileEncryptor — buffer mode", () => {
  const fe = new FileEncryptor({ chunkSize: 1024 });

  it.each([0, 1, 1023, 1024, 1025, 4096, 100_000])("round-trips %i bytes", (size) => {
    const data = mk(size);
    const enc = fe.encryptBuffer(data, key);
    expect(enc).toBeInstanceOf(EncryptedFile);
    expect(fe.decryptBuffer(enc, key)).toEqual(data);
  });

  it("splits large input into multiple chunks", () => {
    const enc = fe.encryptBuffer(randomBytes(4096), key, { metadata: { contentType: "application/octet-stream" } });
    expect(enc.chunkCount).toBe(4);
    expect(enc.metadata.originalSize).toBe(4096);
  });

  it("serializes and deserializes an encrypted file", () => {
    const data = randomBytes(3000);
    const wire = fe.encryptBuffer(data, key).serialize();
    expect(fe.decryptBuffer(EncryptedFile.deserialize(wire), key)).toEqual(data);
  });

  it("fails with the wrong key", () => {
    const enc = fe.encryptBuffer(randomBytes(2048), key);
    expect(() => fe.decryptBuffer(enc, SymmetricKey.generate())).toThrow(FileEncryptionError);
  });

  it("detects a tampered chunk", () => {
    const enc = fe.encryptBuffer(randomBytes(3000), key);
    const chunks = [...enc.chunks];
    chunks[1] = "A" + chunks[1]!.slice(1);
    expect(() => fe.decryptBuffer(new EncryptedFile(enc.header, chunks), key)).toThrow(FileEncryptionError);
  });

  it("detects reordered chunks", () => {
    const enc = fe.encryptBuffer(randomBytes(3000), key);
    const chunks = [...enc.chunks];
    [chunks[0], chunks[1]] = [chunks[1]!, chunks[0]!];
    expect(() => fe.decryptBuffer(new EncryptedFile(enc.header, chunks), key)).toThrow(FileEncryptionError);
  });

  it("detects truncation (dropped final chunk)", () => {
    const enc = fe.encryptBuffer(randomBytes(3000), key);
    const truncated = new EncryptedFile(enc.header, enc.chunks.slice(0, -1));
    // The new "last" chunk was encrypted with isFinal=false, so its AAD won't match.
    expect(() => fe.decryptBuffer(truncated, key)).toThrow(FileEncryptionError);
  });

  it("encryptAttachment yields an EncryptedAttachment with metadata", () => {
    const att = fe.encryptAttachment(randomBytes(500), key, { contentType: "image/png", name: "pic" });
    expect(att).toBeInstanceOf(EncryptedAttachment);
    expect(att.contentType).toBe("image/png");
    expect(att.name).toBe("pic");
    const restored = EncryptedAttachment.deserialize(att.serialize());
    expect(fe.decryptBuffer(restored, key)).toHaveLength(500);
  });
});

describe("FileEncryptor — streaming mode", () => {
  const fe = new FileEncryptor({ chunkSize: 512 });

  it("round-trips a stream", async () => {
    const pieces = [randomBytes(300), randomBytes(700), randomBytes(50)];
    const original = concat(pieces);
    const frames = await collect(fe.encryptStream(fromChunks(pieces), key));
    expect(frames[0]!.type).toBe("header");
    const out = await collect(fe.decryptStream(fromChunks2(frames), key));
    expect(concat(out)).toEqual(original);
  });

  it("round-trips an empty stream", async () => {
    const frames = await collect(fe.encryptStream(fromChunks([]), key));
    const out = await collect(fe.decryptStream(fromChunks2(frames), key));
    expect(concat(out)).toHaveLength(0);
  });

  it("detects truncation of a stream", async () => {
    const frames = await collect(fe.encryptStream(fromChunks([randomBytes(2000)]), key));
    const truncated = frames.slice(0, -1); // drop the final chunk frame
    await expect(collect(fe.decryptStream(fromChunks2(truncated), key))).rejects.toBeInstanceOf(StreamError);
  });

  it("detects reordering of stream chunks", async () => {
    const frames = await collect(fe.encryptStream(fromChunks([randomBytes(2000)]), key));
    // swap two chunk frames (indices 1 and 2 in the frame list, i.e. chunks 0 and 1)
    const reordered = [...frames];
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    await expect(collect(fe.decryptStream(fromChunks2(reordered), key))).rejects.toBeInstanceOf(StreamError);
  });

  it("rejects a chunk frame before the header", async () => {
    const bad: EncryptedStreamFrame[] = [{ type: "chunk", index: 0, isFinal: true, data: "AAAA" }];
    await expect(collect(fe.decryptStream(fromChunks2(bad), key))).rejects.toBeInstanceOf(StreamError);
  });

  it("streamed output decrypts identically to buffer output for the same key", async () => {
    const data = randomBytes(1500);
    const frames = await collect(fe.encryptStream(fromChunks([data]), key));
    const streamed = concat(await collect(fe.decryptStream(fromChunks2(frames), key)));
    expect(streamed).toEqual(data);
  });
});

async function* fromChunks2(frames: EncryptedStreamFrame[]): AsyncGenerator<EncryptedStreamFrame> {
  for (const f of frames) yield f;
}
