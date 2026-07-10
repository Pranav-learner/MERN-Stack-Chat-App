/**
 * @module secure-transport/interceptor
 *
 * The bridge that activates end-to-end encryption in the Sprint 5 message pipeline.
 * It builds a Sprint 5 `EncryptionInterceptor` whose `encryptOutbound` runs the
 * Secure Transport encryptor (sealing the envelope's `payload` into `encryption`,
 * `secured: true`) and whose `decryptInbound` runs the decryptor.
 *
 * Registering this interceptor is the ONLY change needed to turn the session-aware app
 * (Sprint 5) into an end-to-end encrypted app — no controller / route / pipeline edits.
 *
 * @security This runs on a DEVICE (client / reference / tests) where session keys live.
 * On the SERVER it is NOT registered — the server relays ciphertext the client already
 * produced. The interceptor uses the pipeline's session CONTEXT (sessionId, keyId) +
 * an injected `keyProvider`; it never fabricates keys.
 *
 * @example Layer-5-style activation on a device
 * ```js
 * import { setEncryptionInterceptor } from "../session-integration/index.js";
 * import { createSecureTransportInterceptor } from "./secure-transport/index.js";
 * setEncryptionInterceptor(createSecureTransportInterceptor({
 *   keyProvider: (sessionId) => secureSessionManager.loadSessionKeys(sessionId),
 * }));
 * ```
 */

import { encryptMessage } from "../encryptor/encryptor.js";
import { decryptMessage } from "../decryptor/decryptor.js";
import { SessionKeyError } from "../errors.js";

/**
 * Build a Sprint 5 encryption interceptor backed by the Secure Transport Layer.
 * @param {object} deps
 * @param {(sessionId: string) => object} deps.keyProvider device-local session keys
 * @param {{ senderDevice?: string }} [deps.identity] optional device binding for outbound metadata
 * @returns {import("../../session-integration/interceptors/encryptionInterceptor.js").EncryptionInterceptor}
 */
export function createSecureTransportInterceptor(deps) {
  if (!deps || typeof deps.keyProvider !== "function") {
    throw new Error("createSecureTransportInterceptor requires a keyProvider(sessionId)");
  }
  const keyProvider = deps.keyProvider;

  return {
    name: "secure-transport-aes-256-gcm",

    /** Seal the plaintext payload → ciphertext (E2E). Falls back untouched if no session. */
    encryptOutbound(envelope, context) {
      // Only encrypt when a real session backs the message.
      if (!context?.sessionId || envelope.fallback || context.resolved === false) {
        return { ...envelope, secured: false, encryption: null };
      }
      const keys = keyProvider(context.sessionId);
      if (!keys) throw new SessionKeyError("No session keys to encrypt", { details: { sessionId: context.sessionId } });
      const secure = encryptMessage(envelope.payload, keys, {
        sessionId: context.sessionId,
        senderDevice: context.senderDevice ?? deps.identity?.senderDevice,
        receiverDevice: context.receiverDevice,
      });
      // The pipeline envelope now carries ciphertext only; plaintext is removed.
      return { ...envelope, secured: true, encryption: secure, payload: null };
    },

    /** Open an inbound ciphertext envelope → plaintext. */
    decryptInbound(envelope, context) {
      if (!envelope.secured || !envelope.encryption) return envelope;
      const keys = keyProvider(context?.sessionId ?? envelope.encryption.sessionId);
      const message = decryptMessage(envelope.encryption, keys);
      return { ...envelope, secured: false, payload: message };
    },
  };
}
