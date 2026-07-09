/**
 * @module payloads
 *
 * Reusable, chat-agnostic encrypted/signed payload models. They wrap Sprint 1
 * value objects ({@link EncryptedPayload}, {@link Signature}) with metadata and
 * versioned, self-describing (de)serialization.
 *
 * - {@link EncryptedBuffer} — an encrypted blob + {@link ContentMetadata}.
 * - {@link SignedPayload} — a signature (+ metadata) with optional attached payload.
 * - {@link EncryptedFile} — a chunked, streaming-encrypted file.
 * - {@link EncryptedAttachment} — an {@link EncryptedFile} with attachment metadata.
 */

import {
  EncryptedPayload,
  Signature,
  fromBase64,
  toBase64,
  type EncryptedPayloadJSON,
} from "@securechat/crypto-sdk";
import type { ContentMetadata, EncryptedFileHeader } from "../types/index.js";
import { PayloadError } from "../errors/index.js";

/** Current payload format version. */
export const PAYLOAD_VERSION = 1;

// ---------------------------------------------------------------------------
// EncryptedBuffer
// ---------------------------------------------------------------------------

/** JSON form of an {@link EncryptedBuffer}. */
export interface EncryptedBufferJSON {
  format: "securechat-encrypted-buffer";
  version: number;
  payload: EncryptedPayloadJSON;
  metadata: ContentMetadata;
}

/** An encrypted in-memory blob with content metadata. */
export class EncryptedBuffer {
  constructor(
    public readonly payload: EncryptedPayload,
    public readonly metadata: ContentMetadata = {},
  ) {}

  /** Ciphertext bytes. */
  get ciphertext(): Uint8Array {
    return this.payload.ciphertext;
  }

  toJSON(): EncryptedBufferJSON {
    return {
      format: "securechat-encrypted-buffer",
      version: PAYLOAD_VERSION,
      payload: this.payload.toJSON(),
      metadata: this.metadata,
    };
  }

  /** Serialize to a compact JSON string. */
  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Reconstruct from the JSON form. @throws {PayloadError} */
  static fromJSON(obj: EncryptedBufferJSON): EncryptedBuffer {
    if (obj?.format !== "securechat-encrypted-buffer") {
      throw new PayloadError("Not an encrypted-buffer payload");
    }
    if (obj.version !== PAYLOAD_VERSION) {
      throw new PayloadError(`Unsupported encrypted-buffer version ${obj.version}`);
    }
    try {
      return new EncryptedBuffer(EncryptedPayload.fromJSON(obj.payload), obj.metadata ?? {});
    } catch (cause) {
      throw new PayloadError("Failed to parse encrypted-buffer payload", { cause });
    }
  }

  /** Parse a serialized string. @throws {PayloadError} */
  static deserialize(serialized: string): EncryptedBuffer {
    return EncryptedBuffer.fromJSON(parseJson<EncryptedBufferJSON>(serialized, "encrypted-buffer"));
  }
}

// ---------------------------------------------------------------------------
// SignedPayload
// ---------------------------------------------------------------------------

/** Metadata attached to a signature. */
export interface SignatureMetadata {
  version: number;
  algorithm: "ed25519";
  /** Hex SHA-256 fingerprint of the signer's public key. */
  signerFingerprint: string;
  /** ISO-8601 signing time. */
  createdAt: string;
}

/** JSON form of a {@link SignedPayload}. */
export interface SignedPayloadJSON {
  format: "securechat-signed-payload";
  version: number;
  /** base64 signature bytes. */
  signature: string;
  metadata: SignatureMetadata;
  /** base64 attached payload; absent for a detached signature. */
  payload?: string;
}

/**
 * A signature plus metadata, with an OPTIONAL attached payload. When `payload`
 * is absent the signature is *detached* and the message must be supplied
 * separately at verification time.
 */
export class SignedPayload {
  constructor(
    public readonly signature: Signature,
    public readonly metadata: SignatureMetadata,
    /** The signed bytes, if attached. */
    public readonly payload?: Uint8Array,
  ) {}

  /** Whether this is a detached signature (no attached payload). */
  get isDetached(): boolean {
    return this.payload === undefined;
  }

  toJSON(): SignedPayloadJSON {
    const json: SignedPayloadJSON = {
      format: "securechat-signed-payload",
      version: PAYLOAD_VERSION,
      signature: this.signature.toBase64(),
      metadata: this.metadata,
    };
    if (this.payload !== undefined) json.payload = toBase64(this.payload);
    return json;
  }

  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Reconstruct from the JSON form. @throws {PayloadError} */
  static fromJSON(obj: SignedPayloadJSON): SignedPayload {
    if (obj?.format !== "securechat-signed-payload") {
      throw new PayloadError("Not a signed payload");
    }
    if (obj.version !== PAYLOAD_VERSION) {
      throw new PayloadError(`Unsupported signed-payload version ${obj.version}`);
    }
    try {
      const signature = Signature.fromBase64(obj.signature);
      const payload = obj.payload !== undefined ? fromBase64(obj.payload) : undefined;
      return new SignedPayload(signature, obj.metadata, payload);
    } catch (cause) {
      throw new PayloadError("Failed to parse signed payload", { cause });
    }
  }

  /** Parse a serialized string. @throws {PayloadError} */
  static deserialize(serialized: string): SignedPayload {
    return SignedPayload.fromJSON(parseJson<SignedPayloadJSON>(serialized, "signed-payload"));
  }
}

// ---------------------------------------------------------------------------
// EncryptedFile / EncryptedAttachment
// ---------------------------------------------------------------------------

/** JSON form of an {@link EncryptedFile}. */
export interface EncryptedFileJSON {
  header: EncryptedFileHeader;
  chunks: string[];
}

/** A chunked, streaming-encrypted file: a header plus base64 chunk frames. */
export class EncryptedFile {
  constructor(
    public readonly header: EncryptedFileHeader,
    /** base64(ciphertext||authTag) for each chunk, in order. */
    public readonly chunks: string[],
  ) {}

  /** Number of chunks. */
  get chunkCount(): number {
    return this.chunks.length;
  }

  /** Content metadata from the header. */
  get metadata(): ContentMetadata {
    return this.header.metadata;
  }

  toJSON(): EncryptedFileJSON {
    return { header: this.header, chunks: this.chunks };
  }

  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Reconstruct from the JSON form. @throws {PayloadError} */
  static fromJSON(obj: EncryptedFileJSON): EncryptedFile {
    if (obj?.header?.format !== "securechat-encrypted-file") {
      throw new PayloadError("Not an encrypted-file payload");
    }
    if (!Array.isArray(obj.chunks)) {
      throw new PayloadError("Encrypted file is missing its chunks array");
    }
    return new EncryptedFile(obj.header, obj.chunks);
  }

  /** Parse a serialized string. @throws {PayloadError} */
  static deserialize(serialized: string): EncryptedFile {
    return EncryptedFile.fromJSON(parseJson<EncryptedFileJSON>(serialized, "encrypted-file"));
  }
}

/**
 * An {@link EncryptedFile} specialized for attachments — its metadata is
 * guaranteed to include a `contentType`. Purely structural; no chat coupling.
 */
export class EncryptedAttachment extends EncryptedFile {
  /** MIME type of the original content. */
  get contentType(): string {
    return this.header.metadata.contentType ?? "application/octet-stream";
  }

  /** Original size in bytes, if known. */
  get size(): number | undefined {
    return this.header.metadata.originalSize;
  }

  /** Opaque logical name, if any. */
  get name(): string | undefined {
    return this.header.metadata.name;
  }

  /** Reconstruct an attachment from the JSON form. */
  static override fromJSON(obj: EncryptedFileJSON): EncryptedAttachment {
    const file = EncryptedFile.fromJSON(obj);
    return new EncryptedAttachment(file.header, file.chunks);
  }

  /** Parse a serialized attachment string. */
  static override deserialize(serialized: string): EncryptedAttachment {
    return EncryptedAttachment.fromJSON(
      parseJson<EncryptedFileJSON>(serialized, "encrypted-attachment"),
    );
  }
}

// ---------------------------------------------------------------------------

function parseJson<T>(serialized: string, label: string): T {
  try {
    return JSON.parse(serialized) as T;
  } catch (cause) {
    throw new PayloadError(`Serialized ${label} is not valid JSON`, { cause });
  }
}
