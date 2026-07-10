/**
 * @module key-hierarchy/transport
 *
 * **Secure Transport integration** for the key hierarchy. It formalises the encryption
 * key-resolution PATH:
 *
 * ```
 * Session ─▶ Root Key ─▶ Current Sending Chain ─▶ [Future Message Key Hook] ─▶ Encryption
 * ```
 *
 * @important Sprint 4 creates the resolution path + a **message-key extension point ONLY**.
 * It does NOT derive per-message keys. When no `messageKeyHook` is supplied (the default),
 * encryption falls back to the Sprint 2 forward-secrecy session keys — behaviour is
 * unchanged and additive. Sprint 5 will supply a `messageKeyHook` that derives a unique key
 * from the current sending-chain key, and the path above starts producing per-message keys
 * with zero transport-layer changes.
 *
 * @security No keys pass through this module. It delegates to the Sprint 2 forward-secrecy
 * transport helpers (which own the device-local key material) and, in the future, to the
 * injected hook.
 */

import { encryptMessage } from "../../secure-transport/encryptor/encryptor.js";
import { encryptWithForwardSecrecy, decryptWithForwardSecrecy } from "../../forward-secrecy/transport/transportIntegration.js";

/**
 * Resolve (and validate) the session's ACTIVE sending chain metadata — the first hop of the
 * encryption path. Throws if the hierarchy is not established.
 * @param {import("../manager/chainManager.js").ChainManager} chainManager @param {string} sessionId
 * @returns {Promise<{ generation: number, rootKeyId: string, sendingChain: object }>}
 */
export async function resolveActiveSendingChain(chainManager, sessionId) {
  const status = await chainManager.getStatus(sessionId); // throws HierarchyNotFoundError if absent
  const sendingChain = await chainManager.getSendingChain(sessionId);
  return { generation: status.generation, rootKeyId: status.rootKeyId, sendingChain };
}

/**
 * Encrypt a message via the hierarchy resolution path.
 *
 * - **With** a `messageKeyHook` (Sprint 5): derive a per-message key from the current
 *   sending-chain key and seal with it.
 * - **Without** (Sprint 4 default): seal with the Sprint 2 forward-secrecy session keys.
 *
 * @param {object} message @param {object} context `{ sessionId, senderDevice?, receiverDevice?, ... }`
 * @param {{ chainManager: object, forwardSecrecy: object, messageKeyHook?: (input: {chainKey: Buffer, index: number, sessionId: string}) => object }} deps
 * @returns {Promise<object>} a SecurePayload
 */
export async function encryptWithHierarchy(message, context, deps) {
  const { chainManager, forwardSecrecy, messageKeyHook } = deps;
  // Path hop 1–3: Session → Root → Current Sending Chain (validates the hierarchy exists).
  await resolveActiveSendingChain(chainManager, context.sessionId);

  if (typeof messageKeyHook === "function") {
    // Path hop 4 (Sprint 5): derive a per-message key from the sending-chain key.
    const { chainKey, index } = chainManager.resolveSendingChainKey(context.sessionId);
    const messageKeys = messageKeyHook({ chainKey, index, sessionId: context.sessionId });
    return encryptMessage(message, messageKeys, context);
  }
  // Sprint 4: no per-message keys yet → seal with the forward-secrecy session keys.
  return encryptWithForwardSecrecy(message, context, { forwardSecrecy });
}

/**
 * Decrypt a SecurePayload. In Sprint 4 this delegates to the forward-secrecy decryptor
 * (resolves the generation by `keyId`); Sprint 5 will resolve per-message keys from the
 * receiving chain via a hook.
 * @param {object} payload @param {{ forwardSecrecy: object }} deps @param {object} [options]
 * @returns {object} the decrypted message
 */
export function decryptWithHierarchy(payload, deps, options = {}) {
  return decryptWithForwardSecrecy(payload, { forwardSecrecy: deps.forwardSecrecy }, options);
}

/**
 * Build a reusable encryption resolver bound to a chain manager + forward-secrecy engine
 * (and, in the future, a message-key hook). Returns `{ encrypt, decrypt }`.
 * @param {{ chainManager: object, forwardSecrecy: object, messageKeyHook?: Function }} deps
 */
export function createHierarchyTransport(deps) {
  return {
    encrypt: (message, context) => encryptWithHierarchy(message, context, deps),
    decrypt: (payload, options) => decryptWithHierarchy(payload, deps, options),
    /** Whether per-message key derivation is active (Sprint 5 wires the hook). */
    perMessageKeys: typeof deps.messageKeyHook === "function",
  };
}
