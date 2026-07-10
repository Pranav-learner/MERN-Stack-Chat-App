/**
 * @module secure-transport/metadata
 *
 * Secure-payload metadata: the PUBLIC, authenticated fields that describe an encrypted
 * message without revealing its content (session/device binding, versions, type,
 * timestamp, replay nonce). The metadata is bound into the AEAD as **AAD**, so a relay
 * or attacker cannot tamper with any field without breaking decryption.
 *
 * @security Metadata contains NO plaintext and NO keys. The canonical AAD string is a
 * deterministic, order-fixed encoding so sender and receiver derive identical AAD.
 */

import crypto from "node:crypto";
import { PAYLOAD_ENVELOPE_VERSION, PAYLOAD_VERSION, MessageType } from "../types.js";
import { MalformedPayloadError } from "../errors.js";

/**
 * Build the metadata block for an outbound message.
 * @param {object} params
 * @param {string} params.sessionId @param {string} params.keyId
 * @param {string} params.senderDevice @param {string} [params.receiverDevice]
 * @param {string} [params.type=MessageType.MESSAGE] @param {string} [params.protocolVersion="1.0"]
 * @param {() => number} [params.clock]
 * @returns {object} the metadata block (goes into the SecurePayload as top-level fields)
 */
export function buildMetadata(params) {
  const clock = params.clock ?? (() => Date.now());
  return {
    v: PAYLOAD_ENVELOPE_VERSION,
    payloadVersion: PAYLOAD_VERSION,
    type: params.type ?? MessageType.MESSAGE,
    protocolVersion: params.protocolVersion ?? "1.0",
    sessionId: String(params.sessionId),
    keyId: String(params.keyId),
    senderDevice: params.senderDevice ? String(params.senderDevice) : "",
    receiverDevice: params.receiverDevice ? String(params.receiverDevice) : "",
    timestamp: clock(),
    nonce: crypto.randomBytes(16).toString("hex"),
  };
}

/**
 * The canonical AAD bytes for a metadata block — a deterministic, order-fixed encoding
 * bound into the AEAD. Any change to a field changes the AAD and breaks decryption.
 * @param {object} meta @returns {Buffer}
 */
export function canonicalAAD(meta) {
  const canon = [
    "SHS-transport-v1",
    meta.v,
    meta.payloadVersion,
    meta.type,
    meta.protocolVersion,
    meta.sessionId,
    meta.keyId,
    meta.senderDevice,
    meta.receiverDevice,
    meta.timestamp,
    meta.nonce,
  ].join("|");
  return Buffer.from(canon, "utf8");
}

/** Validate a metadata block has the required, well-typed fields. @throws {MalformedPayloadError} */
export function validateMetadata(meta) {
  if (!meta || typeof meta !== "object") throw new MalformedPayloadError("Metadata missing");
  for (const [field, type] of [
    ["v", "number"],
    ["payloadVersion", "number"],
    ["type", "string"],
    ["protocolVersion", "string"],
    ["sessionId", "string"],
    ["keyId", "string"],
    ["timestamp", "number"],
    ["nonce", "string"],
  ]) {
    if (typeof meta[field] !== type || (type === "string" && !meta[field])) {
      throw new MalformedPayloadError(`Metadata field "${field}" invalid`, { details: { field } });
    }
  }
  return meta;
}

/** Whole-payload replay key (nonce is unique per message). */
export function replayKey(meta) {
  return `${meta.sessionId}:${meta.nonce}`;
}
