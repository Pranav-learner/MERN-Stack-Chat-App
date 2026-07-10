/**
 * @module session-integration/adapters/restAdapter
 *
 * Adapts Express REST requests to the transport-independent {@link MessagePipeline}.
 * Extracts pipeline input from a request and builds a `transport` closure that
 * persists the message (with its session metadata) and emits it — keeping the existing
 * controller behaviour intact while routing it through the session layer.
 *
 * @security Session awareness only. The persisted `session` metadata is PUBLIC
 * (sessionId, keyId, secured=false, transportMode). No message content is encrypted.
 */

import { sessionMetadataOf } from "../transport/securePayload.js";

/**
 * Extract pipeline input from an Express request.
 * @param {import("express").Request} req
 * @param {{ peerParam?: string }} [options]
 * @returns {{ sender: string, recipient: string|null, groupId: string|null, message: object }}
 */
export function pipelineInputFromRequest(req, options = {}) {
  const peerParam = options.peerParam ?? "id";
  const { text, image } = req.body ?? {};
  return {
    sender: String(req.user._id),
    recipient: req.params?.[peerParam] ?? req.body?.recipientId ?? null,
    groupId: req.params?.groupId ?? req.body?.groupId ?? null,
    message: { text, image },
  };
}

/**
 * Build a REST transport that persists a message + emits it over Socket.IO, attaching
 * the session metadata from the prepared envelope. The persistence + emit callbacks are
 * injected so this stays free of direct Mongo/io imports (testable).
 *
 * @param {object} deps
 * @param {(doc: object, meta: object) => Promise<object>} deps.persist create the message document
 * @param {(message: object, envelope: object, context: object) => Promise<void>|void} [deps.emit] deliver over the transport
 * @returns {(envelope: object, context: object) => Promise<object>} a pipeline transport
 */
export function makeRestTransport(deps) {
  if (!deps || typeof deps.persist !== "function") {
    throw new Error("makeRestTransport requires a persist(doc, meta) function");
  }
  return async function restTransport(envelope, context) {
    const meta = sessionMetadataOf(envelope);
    // The plaintext body lives in envelope.payload in Sprint 5; Layer 5 will instead
    // carry envelope.encryption and persist ciphertext.
    const message = await deps.persist(envelope.payload, meta);
    if (deps.emit) await deps.emit(message, envelope, context);
    return message;
  };
}
