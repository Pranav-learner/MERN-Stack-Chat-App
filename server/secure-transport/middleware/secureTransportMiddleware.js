/**
 * @module secure-transport/middleware
 *
 * Server-side (relay) Express middleware. The server validates + routes ciphertext; it
 * NEVER decrypts. These middleware enforce that.
 *
 * - **validateSecurePayload** — if the request carries a `securePayload`, validate it
 *   for relay (shape, version, no-plaintext, session/device binding) and attach the
 *   validated `{ payload, meta }` to `req.secureTransport`. Absent ⇒ pass through
 *   (plaintext fallback path).
 * - **requireCiphertext** — reject a plaintext send when end-to-end is enforced.
 *
 * @security The server has no keys and cannot decrypt. `validateSecurePayload` confirms
 * only structure + binding. A payload that carries plaintext is rejected.
 */

import { SecureTransportManager } from "../manager/secureTransportManager.js";
import { looksLikePlaintext } from "../validators/validators.js";
import { SecureTransportError, MalformedPayloadError } from "../errors.js";

/**
 * Build the relay middleware.
 * @param {object} [deps]
 * @param {SecureTransportManager} [deps.manager] a relay manager (no keyProvider)
 * @param {boolean} [deps.enforceE2E=false] reject plaintext sends when true
 * @returns {{ validateSecurePayload: Function, requireCiphertext: Function }}
 */
export function createSecureTransportMiddleware(deps = {}) {
  const manager = deps.manager ?? new SecureTransportManager(); // relay (no keys)
  const enforceE2E = deps.enforceE2E ?? false;

  /** Validate + attach an incoming secure payload; pass through if none. */
  function validateSecurePayload(req, res, next) {
    const secure = req.body?.securePayload;
    if (!secure) return next();
    try {
      const expected = { sessionId: req.body?.sessionId, senderDevice: req.body?.senderDevice };
      req.secureTransport = manager.relay(secure, expected);
      return next();
    } catch (error) {
      if (error instanceof SecureTransportError) {
        return res.status(error.status).json({ success: false, code: error.code, message: error.message });
      }
      return res.status(400).json({ success: false, code: "ERR_TRANSPORT_MALFORMED", message: "Invalid secure payload" });
    }
  }

  /** Reject a plaintext send when E2E is enforced. */
  function requireCiphertext(req, res, next) {
    if (!enforceE2E) return next();
    if (req.secureTransport) return next(); // valid ciphertext present
    if (looksLikePlaintext(req.body)) {
      const err = new MalformedPayloadError("End-to-end encryption is required — send a securePayload");
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    return next();
  }

  return { validateSecurePayload, requireCiphertext };
}
