/**
 * @module controllers/cryptoHardeningController
 *
 * HTTP handlers for the **Cryptographic Hardening** subsystem (Layer 5, Sprint 6). Exposes
 * production observability + security posture: metrics (JSON + Prometheus), recent security
 * alerts, the protocol-freeze manifest, and per-session replay status. The process-wide
 * hardening singletons (metrics registry, replay guard, security monitor) are created here and
 * exported so other layers can feed them.
 *
 * @security Read-only. Everything returned is METADATA + aggregates — never key material.
 * Routes are JWT-protected; per-session routes enforce participation.
 */

import { MetricsRegistry } from "../crypto-hardening/observability/metrics.js";
import { ReplayGuard } from "../crypto-hardening/replay/replayGuard.js";
import { SecurityMonitor } from "../crypto-hardening/monitoring/securityMonitor.js";
import { HardeningEventBus } from "../crypto-hardening/events/events.js";
import { protocolManifest } from "../crypto-hardening/freeze/protocolFreeze.js";
import { HardeningError } from "../crypto-hardening/errors.js";
import { sessionManager } from "./secureSessionController.js";

/** Process-wide hardening singletons — other controllers/layers feed these. */
export const hardeningEvents = new HardeningEventBus();
export const cryptoMetrics = new MetricsRegistry();
export const replayGuard = new ReplayGuard({ events: hardeningEvents, metrics: cryptoMetrics });
export const securityMonitor = new SecurityMonitor({ events: hardeningEvents, metrics: cryptoMetrics });
securityMonitor.subscribe(hardeningEvents);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof HardeningError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** GET /api/crypto-hardening/metrics — metrics snapshot (JSON) or Prometheus (?format=prometheus). */
export const getMetrics = async (req, res) => {
  try {
    if (req.query?.format === "prometheus") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      return res.status(200).send(cryptoMetrics.prometheus());
    }
    return res.status(200).json({ success: true, metrics: cryptoMetrics.snapshot() });
  } catch (error) {
    return handleError(res, error, "getMetrics");
  }
};

/** GET /api/crypto-hardening/alerts — recent security alerts + monitor report. */
export const getAlerts = async (req, res) => {
  try {
    return res.status(200).json({ success: true, report: securityMonitor.report() });
  } catch (error) {
    return handleError(res, error, "getAlerts");
  }
};

/** GET /api/crypto-hardening/protocol — the frozen protocol manifest + Layer 6 extension points. */
export const getProtocol = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, protocol: protocolManifest() });
  } catch (error) {
    return handleError(res, error, "getProtocol");
  }
};

/** GET /api/crypto-hardening/replay/:sessionId — replay-window status for a session. */
export const getReplayStatus = async (req, res) => {
  try {
    try {
      await sessionManager.getSession(req.params.sessionId, { actingUser: callerId(req) });
    } catch (error) {
      return res.status(error?.status ?? 500).json({ success: false, code: error?.code, message: error?.message ?? "Internal Server Error" });
    }
    return res.status(200).json({ success: true, replay: replayGuard.status(req.params.sessionId) });
  } catch (error) {
    return handleError(res, error, "getReplayStatus");
  }
};
