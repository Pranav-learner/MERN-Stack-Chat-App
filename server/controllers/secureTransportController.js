/**
 * @module controllers/secureTransportController
 *
 * Layer 4 · Sprint 6 — the server-side **secure relay**. The backend NEVER decrypts:
 * this module builds a relay {@link SecureTransportManager} (no `keyProvider`) that
 * validates + routes ciphertext, exposes the relay middleware for the message route,
 * and serves aggregate transport metrics / status.
 *
 * @security The server has no session keys. It validates a secure payload's structure
 * + binding and persists CIPHERTEXT ONLY. It cannot read message content.
 */

import {
  SecureTransportManager,
  createSecureTransportMiddleware,
} from "../secure-transport/index.js";

/** The production relay manager (no keys → cannot decrypt). */
export const relayManager = new SecureTransportManager();

/** Relay middleware for the messaging route. E2E enforcement is opt-in via env. */
export const secureTransportMiddleware = createSecureTransportMiddleware({
  manager: relayManager,
  enforceE2E: process.env.E2E_REQUIRED === "true",
});

/** GET /api/secure-transport/status — the relay's posture (server never decrypts). */
export const getStatus = async (_req, res) => {
  return res.status(200).json({
    success: true,
    status: {
      role: "relay",
      canDecrypt: false,
      cipher: "aes-256-gcm",
      mac: "hmac-sha256",
      e2eRequired: process.env.E2E_REQUIRED === "true",
      note: "The server relays and stores ciphertext only; it holds no session keys and cannot read message content.",
    },
  });
};

/** GET /api/secure-transport/metrics — aggregate transport metrics (no PII / no content). */
export const getMetrics = async (_req, res) => {
  return res.status(200).json({ success: true, metrics: relayManager.metricsSnapshot() });
};
