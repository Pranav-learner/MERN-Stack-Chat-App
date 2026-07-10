/**
 * @module shs/serializers
 *
 * Reusable serialization for handshake messages. Three interchangeable encodings
 * share one logical envelope:
 *
 * - **JSON**    — canonical, human-readable; the default over HTTP.
 * - **binary**  — a compact framed `Buffer`: `MAGIC(4) | version(1) | flags(1) |
 *                 type(1) | checksum(4) | len(4) | body(len)`.
 * - **compact** — the binary frame, base64url-encoded (safe for URLs / QR / headers).
 *
 * ### Integrity metadata (NOT encryption)
 * Each frame carries a 4-byte CRC32 checksum of the body so a corrupted/truncated
 * frame is rejected on read. This is a tamper-EVIDENCE hook, not confidentiality —
 * confidentiality/authentication belong to a future crypto sprint, which can flip
 * the reserved `ENCRYPTED` flag and wrap the body without changing this envelope.
 *
 * @security No secret material passes through here in Sprint 1. The checksum is a
 * non-cryptographic integrity aid, not a MAC.
 */

import { MessageType } from "../types.js";
import { PROTOCOL_MAGIC, FrameFlags, MAX_MESSAGE_BYTES } from "../protocol/constants.js";
import { CURRENT_VERSION, parseVersion } from "../protocol/version.js";
import { assertEnvelope } from "../messages/messages.js";
import { MessageSerializationError } from "../errors.js";

/** Stable ordering of message types → a 1-byte type code for binary frames. */
const TYPE_CODES = Object.freeze(Object.values(MessageType));
const codeOfType = (type) => {
  const i = TYPE_CODES.indexOf(type);
  if (i < 0) throw new MessageSerializationError(`Unknown message type: ${type}`);
  return i;
};
const typeOfCode = (code) => {
  const t = TYPE_CODES[code];
  if (!t) throw new MessageSerializationError(`Unknown message type code: ${code}`);
  return t;
};

/** CRC32 (IEEE) over a Buffer — small, dependency-free integrity checksum. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// === JSON =================================================================

/**
 * Serialize a message to canonical JSON text.
 * @param {object} message @returns {string}
 * @throws {MessageSerializationError}
 */
export function toJson(message) {
  assertEnvelope(message);
  try {
    const json = JSON.stringify(message);
    if (Buffer.byteLength(json, "utf8") > MAX_MESSAGE_BYTES) {
      throw new MessageSerializationError("Message exceeds maximum size", {
        details: { max: MAX_MESSAGE_BYTES },
      });
    }
    return json;
  } catch (error) {
    if (error instanceof MessageSerializationError) throw error;
    throw new MessageSerializationError("Failed to serialize message to JSON", { cause: error });
  }
}

/**
 * Parse a message from JSON text (validates the envelope only; deep validation is
 * the validators module's job).
 * @param {string} text @returns {object}
 * @throws {MessageSerializationError}
 */
export function fromJson(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (error) {
    throw new MessageSerializationError("Malformed JSON handshake message", { cause: error });
  }
  try {
    return assertEnvelope(obj);
  } catch (error) {
    throw new MessageSerializationError(error.message, { cause: error });
  }
}

// === binary ===============================================================

const HEADER_LEN = 4 /*magic*/ + 1 /*ver*/ + 1 /*flags*/ + 1 /*type*/ + 4 /*crc*/ + 4 /*len*/;

/**
 * Serialize a message to a framed binary `Buffer`.
 * @param {object} message
 * @param {{ flags?: number }} [options]
 * @returns {Buffer}
 * @throws {MessageSerializationError}
 */
export function toBinary(message, options = {}) {
  assertEnvelope(message);
  const body = Buffer.from(toJson(message), "utf8");
  const { major, minor } = parseVersion(message.version ?? CURRENT_VERSION);
  const versionByte = ((major & 0x0f) << 4) | (minor & 0x0f);
  const flags = (options.flags ?? FrameFlags.JSON) & 0xff;

  const header = Buffer.alloc(HEADER_LEN);
  header.write(PROTOCOL_MAGIC, 0, "ascii");
  header.writeUInt8(versionByte, 4);
  header.writeUInt8(flags, 5);
  header.writeUInt8(codeOfType(message.type), 6);
  header.writeUInt32BE(crc32(body), 7);
  header.writeUInt32BE(body.length, 11);
  return Buffer.concat([header, body]);
}

/**
 * Parse a message from a framed binary `Buffer` (verifies magic + checksum + length).
 * @param {Buffer|Uint8Array} buffer @returns {object}
 * @throws {MessageSerializationError}
 */
export function fromBinary(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < HEADER_LEN) {
    throw new MessageSerializationError("Frame shorter than header");
  }
  if (buf.toString("ascii", 0, 4) !== PROTOCOL_MAGIC) {
    throw new MessageSerializationError("Bad protocol magic — not an SHS frame");
  }
  const expectedType = typeOfCode(buf.readUInt8(6));
  const crc = buf.readUInt32BE(7);
  const len = buf.readUInt32BE(11);
  if (len > MAX_MESSAGE_BYTES) {
    throw new MessageSerializationError("Declared body length exceeds maximum");
  }
  if (buf.length !== HEADER_LEN + len) {
    throw new MessageSerializationError("Frame length mismatch (truncated or padded)", {
      details: { expected: HEADER_LEN + len, actual: buf.length },
    });
  }
  const body = buf.subarray(HEADER_LEN);
  if (crc32(body) !== crc) {
    throw new MessageSerializationError("Checksum mismatch — frame corrupted or tampered");
  }
  const message = fromJson(body.toString("utf8"));
  if (message.type !== expectedType) {
    throw new MessageSerializationError("Header type does not match body type", {
      details: { header: expectedType, body: message.type },
    });
  }
  return message;
}

// === compact ==============================================================

/** Serialize to a compact base64url string (binary frame, url/QR safe). */
export function toCompact(message, options = {}) {
  return toBinary(message, options).toString("base64url");
}

/** Parse a compact base64url string back into a message. */
export function fromCompact(text) {
  let buf;
  try {
    buf = Buffer.from(String(text), "base64url");
  } catch (error) {
    throw new MessageSerializationError("Malformed compact frame", { cause: error });
  }
  return fromBinary(buf);
}

// === format-agnostic facade ==============================================

/** Supported serialization formats. @readonly @enum {string} */
export const SerializationFormat = Object.freeze({
  JSON: "json",
  BINARY: "binary",
  COMPACT: "compact",
});

/**
 * Serialize a message in the requested format.
 * @param {object} message @param {string} [format="json"] @param {object} [options]
 * @returns {string|Buffer}
 */
export function serialize(message, format = SerializationFormat.JSON, options = {}) {
  switch (format) {
    case SerializationFormat.JSON:
      return toJson(message);
    case SerializationFormat.BINARY:
      return toBinary(message, options);
    case SerializationFormat.COMPACT:
      return toCompact(message, options);
    default:
      throw new MessageSerializationError(`Unknown serialization format: ${format}`);
  }
}

/**
 * Deserialize a frame in the requested format.
 * @param {string|Buffer|Uint8Array} data @param {string} [format="json"]
 * @returns {object}
 */
export function deserialize(data, format = SerializationFormat.JSON) {
  switch (format) {
    case SerializationFormat.JSON:
      return fromJson(typeof data === "string" ? data : data.toString("utf8"));
    case SerializationFormat.BINARY:
      return fromBinary(data);
    case SerializationFormat.COMPACT:
      return fromCompact(data);
    default:
      throw new MessageSerializationError(`Unknown serialization format: ${format}`);
  }
}
