/**
 * @module session-integration/transport/securePayload
 *
 * Builds the **secure payload envelope** — the "Prepare Secure Payload" pipeline
 * stage. The envelope wraps the message body with the session's PUBLIC metadata and
 * an encryption HOOK that stays `null` until Layer 5. The default no-op
 * {@link module:session-integration/interceptors/encryptionInterceptor} leaves the
 * payload plaintext (`secured: false`).
 *
 * Transport-independent: the same envelope is used for REST responses, socket emits,
 * or any future transport.
 *
 * @security No encryption in Sprint 5. The envelope carries key METADATA (keyId) only,
 * never key bytes. Layer 5 swaps the interceptor to seal `payload` → `encryption`.
 */

import { ENVELOPE_VERSION, TransportMode } from "../types.js";
import { getEncryptionInterceptor } from "../interceptors/encryptionInterceptor.js";

/**
 * Build (and run through the active encryption interceptor) a secure payload envelope.
 *
 * @param {object} message the message body (e.g. `{ text, image }`)
 * @param {import("../types.js").SessionContext} context the resolved session context
 * @param {{ interceptor?: object, meta?: object }} [options]
 * @returns {Promise<import("../types.js").SecurePayloadEnvelope>}
 *
 * @example
 * ```js
 * const envelope = await prepareSecurePayload({ text: "hi" }, sessionContext);
 * envelope.secured; // false in Layer 4; true once Layer 5 registers an interceptor
 * ```
 */
export async function prepareSecurePayload(message, context, options = {}) {
  const interceptor = options.interceptor ?? getEncryptionInterceptor();
  const base = {
    version: ENVELOPE_VERSION,
    sessionId: context.sessionId ?? null,
    keyId: context.keyId ?? null,
    secured: false, // Layer 5 flips this via the interceptor
    encryption: null, // Layer 5 populates: { algorithm, iv, ciphertext, tag }
    transportMode: context.transportMode ?? (context.resolved ? TransportMode.SESSION : TransportMode.FALLBACK),
    fallback: !!context.fallback,
    payload: message ?? {},
    meta: {
      initiator: context.initiator,
      peer: context.peer,
      resolution: context.resolution,
      preparedAt: options.meta?.preparedAt ?? undefined,
      ...(options.meta ?? {}),
    },
  };
  // Run the extension point (no-op in Layer 4).
  return interceptor.encryptOutbound(base, context);
}

/**
 * Reverse an inbound envelope through the interceptor (no-op in Layer 4).
 * @param {object} envelope @param {object} context @param {{ interceptor?: object }} [options]
 * @returns {Promise<object>}
 */
export async function openSecurePayload(envelope, context, options = {}) {
  const interceptor = options.interceptor ?? getEncryptionInterceptor();
  return interceptor.decryptInbound(envelope, context);
}

/**
 * The persisted/serializable session metadata for a message (attached to the Message
 * document + socket event so clients/observability can see the session binding).
 * @param {import("../types.js").SecurePayloadEnvelope} envelope
 * @returns {{ sessionId: string|null, keyId: string|null, secured: boolean, transportMode: string, fallback: boolean }}
 */
export function sessionMetadataOf(envelope) {
  return {
    sessionId: envelope.sessionId,
    keyId: envelope.keyId,
    secured: envelope.secured,
    transportMode: envelope.transportMode,
    fallback: envelope.fallback,
  };
}
