/**
 * @module session-integration/interceptors/encryptionInterceptor
 *
 * The **encryption extension point**. In Sprint 5 this is a NO-OP pass-through — the
 * application becomes session-aware but does not encrypt. Layer 5 registers a real
 * interceptor (using the device-local session keys via
 * `SecureSessionManager.loadSessionKeys`) WITHOUT changing the pipeline, middleware,
 * or controllers.
 *
 * @security The default {@link NoopEncryptionInterceptor} leaves `secured: false` and
 * the `encryption` hook `null`. It never touches keys. Swapping in a real interceptor
 * is the ONLY change Layer 5 needs to make messages confidential.
 */

/**
 * @typedef {object} EncryptionInterceptor
 * @property {(envelope: object, context: object) => Promise<object>|object} encryptOutbound
 *   transform an outbound envelope (Layer 5: seal `payload` → `encryption`, secured=true)
 * @property {(envelope: object, context: object) => Promise<object>|object} decryptInbound
 *   transform an inbound envelope (Layer 5: open `encryption` → `payload`)
 * @property {string} name
 */

/** The default interceptor: identity transform, leaves everything plaintext. */
export class NoopEncryptionInterceptor {
  constructor() {
    this.name = "noop";
  }

  /**
   * Outbound: mark the envelope unsecured and leave the payload as-is. Layer 5 will
   * instead AEAD-seal `envelope.payload` into `envelope.encryption` and set
   * `secured: true`.
   * @param {object} envelope @param {object} _context @returns {object}
   */
  encryptOutbound(envelope, _context) {
    return { ...envelope, secured: false, encryption: null };
  }

  /**
   * Inbound: pass through unchanged (nothing to decrypt).
   * @param {object} envelope @param {object} _context @returns {object}
   */
  decryptInbound(envelope, _context) {
    return envelope;
  }
}

/** The process-wide active interceptor (swappable by Layer 5). */
let __activeInterceptor = new NoopEncryptionInterceptor();

/** Get the active encryption interceptor. */
export function getEncryptionInterceptor() {
  return __activeInterceptor;
}

/**
 * Register the active encryption interceptor (Layer 5 calls this once at startup).
 * @param {EncryptionInterceptor} interceptor
 * @returns {EncryptionInterceptor} the previous interceptor
 */
export function setEncryptionInterceptor(interceptor) {
  if (!interceptor || typeof interceptor.encryptOutbound !== "function" || typeof interceptor.decryptInbound !== "function") {
    throw new Error("An encryption interceptor must implement encryptOutbound + decryptInbound");
  }
  const previous = __activeInterceptor;
  __activeInterceptor = interceptor;
  return previous;
}

/** Reset to the no-op interceptor (e.g. between tests). */
export function resetEncryptionInterceptor() {
  __activeInterceptor = new NoopEncryptionInterceptor();
}

/** Whether encryption is currently active (i.e. a non-noop interceptor is registered). */
export function isEncryptionActive() {
  return __activeInterceptor.name !== "noop";
}
