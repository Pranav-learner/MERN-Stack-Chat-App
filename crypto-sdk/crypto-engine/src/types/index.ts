/**
 * @module types
 *
 * Shared, behaviour-free type declarations for the Crypto Engine.
 */

/** Injectable clock returning epoch milliseconds (for deterministic tests). */
export type Clock = () => number;

/** Logical purpose of a derived key — one axis of key separation. */
export enum DerivationPurpose {
  ENCRYPTION = "encryption",
  MAC = "mac",
  SIGNING = "signing",
  AUTHENTICATION = "authentication",
  KEY_WRAPPING = "key-wrapping",
  GENERIC = "generic",
}

/**
 * A derivation context. Together `(namespace, context, purpose, version)` forms
 * the HKDF `info` label, guaranteeing that keys derived for different uses from
 * the same master key are cryptographically independent.
 */
export interface DerivationContext {
  /** Top-level namespace (default `"securechat"`). */
  namespace?: string;
  /** Application context, e.g. `"session"`, `"file"`, `"attachment"`. */
  context: string;
  /** Logical purpose. */
  purpose: DerivationPurpose | string;
  /** Context version for future rotation of derivation schemes (default 1). */
  version?: number;
}

/** Options for deriving raw bytes / keys from a master key. */
export interface DeriveOptions {
  /** Output length in bytes (default 32). */
  length?: number;
  /** Optional HKDF salt. */
  salt?: Uint8Array | string;
  /** Override the context version (default 1). */
  version?: number;
}

/** Generic, chat-agnostic content descriptor for encrypted payloads/files. */
export interface ContentMetadata {
  /** MIME type, e.g. `"application/octet-stream"`. */
  contentType?: string;
  /** Opaque logical name (NOT a chat/user concept). */
  name?: string;
  /** Original plaintext byte length. */
  originalSize?: number;
  /** ISO-8601 creation timestamp. */
  createdAt?: string;
  /** Arbitrary JSON-serializable extension fields. */
  custom?: Record<string, unknown>;
}

/** Header describing a chunked, streaming-encrypted file. */
export interface EncryptedFileHeader {
  format: "securechat-encrypted-file";
  version: number;
  algorithm: string;
  /** base64 per-stream salt used to derive the stream key. */
  streamSalt: string;
  /** Plaintext chunk size in bytes. */
  chunkSize: number;
  metadata: ContentMetadata;
}

/** A frame emitted/consumed by the streaming file APIs. */
export type EncryptedStreamFrame =
  | { type: "header"; header: EncryptedFileHeader }
  | { type: "chunk"; index: number; isFinal: boolean; data: string };

/** Result of a benchmark run. */
export interface BenchmarkResult {
  label: string;
  iterations: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSecond: number;
  /** Bytes processed per op, if provided. */
  bytesPerOp?: number;
  /** Aggregate throughput in MiB/s, if `bytesPerOp` was provided. */
  throughputMiBps?: number;
}

/** A point-in-time memory sample. */
export interface MemorySample {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

/** Structured result of a non-throwing integrity check. */
export interface IntegrityResult {
  ok: boolean;
  /** Machine-readable reason code when `ok` is false. */
  code?: string;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}
