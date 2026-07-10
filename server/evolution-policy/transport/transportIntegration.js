/**
 * @module evolution-policy/transport
 *
 * **Secure Transport integration** for automatic rekeying. The send path becomes:
 *
 * ```
 * message ─▶ record activity (may auto-rekey) ─▶ resolve ACTIVE generation ─▶ validate ─▶ use latest keys ─▶ encrypt
 * ```
 *
 * The application calls one function to encrypt; it never learns that a rekey happened in
 * between. Message-count (and any other reactive) policies fire transparently as traffic
 * flows, and the message is then sealed under whatever generation is active afterwards.
 *
 * Decryption is unchanged from Sprint 2 — the receiver resolves the sealing generation from
 * the payload's `keyId`, so a message sent just before a rekey still opens.
 *
 * @security No keys pass through this layer — it delegates encryption to the Sprint 2
 * forward-secrecy transport helpers, which own the device-local key material.
 */

import { encryptWithForwardSecrecy, decryptWithForwardSecrecy } from "../../forward-secrecy/transport/transportIntegration.js";

/**
 * Resolve + validate the session's ACTIVE generation. Throws (via the FS engine) if there
 * is no live current generation.
 * @param {object} forwardSecrecy the Sprint 2 ForwardSecrecyManager
 * @param {string} sessionId
 * @returns {Promise<{ generation: number, keyId: string }>}
 */
export async function resolveActiveGeneration(forwardSecrecy, sessionId) {
  const status = await forwardSecrecy.getStatus(sessionId);
  if (!status?.started || status.activeKeyId == null) {
    // Surface a clear FS-layer error by touching the keys (fails closed if absent).
    forwardSecrecy.resolveEncryptionKeys(sessionId);
  }
  return { generation: status.currentGeneration, keyId: status.activeKeyId };
}

/**
 * Encrypt a message with **transparent automatic rekeying**: record the send (which may
 * trigger a policy-driven rekey), then seal under the now-active generation.
 * @param {object} message the plaintext application message
 * @param {object} context `{ sessionId, senderDevice?, receiverDevice?, type?, protocolVersion?, clock? }`
 * @param {{ rekeyManager: import("../manager/automaticRekeyManager.js").AutomaticRekeyManager }} deps
 * @returns {Promise<object>} a SecurePayload (ciphertext only)
 */
export async function encryptWithAutoRekey(message, context, deps) {
  const { rekeyManager } = deps;
  // Record activity → may auto-rekey (message-count / time). The app is oblivious.
  await rekeyManager.recordMessage(context.sessionId).catch(() => {});
  // Seal under the CURRENT (possibly just-advanced) generation.
  return encryptWithForwardSecrecy(message, context, { forwardSecrecy: rekeyManager.fs });
}

/**
 * Decrypt a SecurePayload (resolves the sealing generation from its `keyId`).
 * @param {object} payload @param {{ rekeyManager: import("../manager/automaticRekeyManager.js").AutomaticRekeyManager }} deps
 * @param {object} [options]
 * @returns {object} the decrypted application message
 */
export function decryptWithAutoRekey(payload, deps, options = {}) {
  return decryptWithForwardSecrecy(payload, { forwardSecrecy: deps.rekeyManager.fs }, options);
}

/**
 * A forward-secrecy-aware, auto-rekeying encryption interceptor for the Layer 4 Sprint 5
 * hook (`setEncryptionInterceptor`). Seals outbound envelopes under the latest generation
 * (auto-rekeying first) and opens inbound ones by generation.
 * @param {{ rekeyManager: import("../manager/automaticRekeyManager.js").AutomaticRekeyManager }} deps
 * @returns {{ name: string, encryptOutbound: Function, decryptInbound: Function }}
 */
export function createAutoRekeyInterceptor(deps) {
  return {
    name: "auto-rekey-forward-secrecy",
    async encryptOutbound(envelope, context = {}) {
      const sessionId = context.sessionId ?? envelope.sessionId;
      const encryption = await encryptWithAutoRekey(envelope.payload ?? {}, { ...context, sessionId }, deps);
      return { ...envelope, secured: true, encryption };
    },
    decryptInbound(envelope, context = {}) {
      if (!envelope.secured || !envelope.encryption) return envelope;
      const payload = decryptWithAutoRekey(envelope.encryption, deps, { expectedSessionId: context.sessionId ?? envelope.sessionId });
      return { ...envelope, payload };
    },
  };
}
