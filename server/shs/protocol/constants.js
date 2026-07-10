/**
 * @module shs/protocol/constants
 *
 * Wire-level and lifecycle constants for the Secure Handshake Protocol (Layer 4,
 * Sprint 1). These are protocol metadata — no cryptographic parameters live here
 * (those belong to future sprints).
 */

/** Human/wire name of the protocol. */
export const PROTOCOL_NAME = "SHS";

/**
 * 4-byte magic prefixing every binary/compact frame. Lets a reader reject
 * non-SHS bytes early. ASCII "SHS1".
 */
export const PROTOCOL_MAGIC = "SHS1";

/** Default whole-handshake lifetime before it EXPIRES (ms). */
export const DEFAULT_HANDSHAKE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Default per-step deadline before a TIMEOUT (ms). */
export const DEFAULT_STEP_TIMEOUT_MS = 30 * 1000; // 30 seconds

/** Default number of retries for a logical handshake (restart budget). */
export const DEFAULT_MAX_RETRIES = 3;

/** Default base backoff delay between retries (ms). */
export const DEFAULT_RETRY_BASE_MS = 500;

/** Upper bound on any single computed backoff delay (ms). */
export const DEFAULT_RETRY_MAX_DELAY_MS = 10 * 1000;

/** Maximum serialized message size accepted by validators (bytes). */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/** Bit flags carried in the binary frame header. */
export const FrameFlags = Object.freeze({
  NONE: 0,
  /** Body is JSON (default). */
  JSON: 1 << 0,
  /** Reserved for a future compressed body. */
  COMPRESSED: 1 << 1,
  /** Reserved for a future encrypted body (NOT implemented in Sprint 1). */
  ENCRYPTED: 1 << 2,
});
