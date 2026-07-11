/**
 * @module controllers/networkingHardeningController
 *
 * HTTP handlers for the **Production Networking Hardening** subsystem (Layer 6, Sprint 6), mounted at
 * `/api/networking-hardening`. Exposes READ-ONLY production observability + security posture for the
 * whole Layer-6 control plane: health, metrics (JSON + Prometheus), recent alerts, the frozen
 * protocol manifest, and the API security audit.
 *
 * The process-wide hardening singleton is created here and FED from every Layer-6 subsystem's event
 * bus (discovery, presence, capabilities, PDP, endpoint selection) so failures + successes flow into
 * the metrics + monitor automatically. Wiring is defensive — a monitoring failure never affects the
 * networking path.
 *
 * @security Read-only. Everything returned is METADATA + numeric aggregates — never key material.
 * Routes are JWT-protected.
 */

import { NetworkingHardeningManager } from "../networking-hardening/manager/networkingHardeningManager.js";
import { createHardeningApi } from "../networking-hardening/api/hardeningApi.js";
import { createMongoHardeningRepository } from "../networking-hardening/repository/mongoHardeningRepository.js";
import { HardeningEventBus } from "../networking-hardening/events/events.js";
import { HardeningError } from "../networking-hardening/errors.js";
import { Metric } from "../networking-hardening/types/types.js";

import { discoveryEvents } from "./discoveryController.js";
import { presenceEvents } from "./presenceController.js";
import { capabilityEvents } from "./capabilityController.js";
import { pdpEvents } from "./pdpController.js";
import { endpointEvents } from "./endpointSelectionController.js";

/** Process-wide hardening event bus + alert store. */
export const hardeningEvents = new HardeningEventBus();
const hardeningRepo = createMongoHardeningRepository();

/** The process-wide hardening manager — other layers can import + feed this. */
export const networkingHardening = new NetworkingHardeningManager({ events: hardeningEvents, sink: hardeningRepo.alerts });

/** The stable, read-only observability facade the HTTP handlers delegate to. */
export const hardeningApi = createHardeningApi(networkingHardening, { repository: hardeningRepo.alerts });

// ── feed the metrics + monitor from every Layer-6 subsystem (defensive) ─────
try {
  const m = networkingHardening.metrics;
  const mon = networkingHardening.monitor;

  // Discovery outcomes.
  discoveryEvents.on("discovery.resolved", () => m.recordDiscovery(true));
  discoveryEvents.on("discovery.failed", (e) => { m.recordDiscovery(false); mon.onDiscoveryFailure({ subject: e?.requester }); });
  discoveryEvents.on("discovery.cached", () => m.recordCache(true));

  // Presence: heartbeat misses + expiries → instability signal.
  presenceEvents.on("presence.heartbeat_missed", (e) => { m.increment(Metric.HEARTBEAT_FAILURE); mon.onPresenceInstability({ deviceId: e?.deviceId }); });
  presenceEvents.on("presence.expired", (e) => mon.onPresenceInstability({ deviceId: e?.deviceId }));
  presenceEvents.on("presence.updated", () => m.increment(Metric.PRESENCE_UPDATE));

  // Capability negotiation.
  capabilityEvents.on("capabilities.negotiation_succeeded", () => m.increment(Metric.NEGOTIATION_TOTAL));
  capabilityEvents.on("capabilities.negotiation_failed", (e) => { m.increment(Metric.NEGOTIATION_TOTAL); mon.onCapabilityMismatch({ subject: e?.targetUser }); });

  // PDP workflow outcomes.
  pdpEvents.on("pdp.connection_plan_created", () => m.increment(Metric.PLAN_GENERATED));
  pdpEvents.on("pdp.workflow_failed", (e) => mon.onDiscoveryFailure({ subject: e?.requester }));

  // Endpoint selection outcomes + churn.
  endpointEvents.on("endpoint.plan_created", () => m.increment(Metric.PLAN_GENERATED));
  endpointEvents.on("endpoint.selection_failed", (e) => mon.onDiscoveryFailure({ subject: e?.requester }));
  endpointEvents.on("endpoint.routing_updated", (e) => mon.onEndpointChurn({ planId: e?.planId }));
} catch (error) {
  console.error("Error wiring networking-hardening monitors:", error?.message);
}

function handleError(res, error, where) {
  if (error instanceof HardeningError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** GET /api/networking-hardening/health — consolidated control-plane health snapshot. */
export const getHealth = async (req, res) => {
  try {
    return res.status(200).json({ success: true, health: await hardeningApi.health() });
  } catch (error) {
    return handleError(res, error, "getHealth");
  }
};

/** GET /api/networking-hardening/metrics — metrics (JSON) or Prometheus (?format=prometheus). */
export const getMetrics = async (req, res) => {
  try {
    if (req.query?.format === "prometheus") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      return res.status(200).send(await hardeningApi.prometheus());
    }
    return res.status(200).json({ success: true, metrics: await hardeningApi.metrics() });
  } catch (error) {
    return handleError(res, error, "getMetrics");
  }
};

/** GET /api/networking-hardening/alerts — recent alerts (paginated: ?alertType=&severity=&limit=&offset=). */
export const getAlerts = async (req, res) => {
  try {
    const result = await hardeningApi.alerts(req.query ?? {});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "getAlerts");
  }
};

/** GET /api/networking-hardening/protocol — the frozen protocol manifest + extension points. */
export const getProtocol = async (req, res) => {
  try {
    return res.status(200).json({ success: true, protocol: await hardeningApi.protocol() });
  } catch (error) {
    return handleError(res, error, "getProtocol");
  }
};

/** GET /api/networking-hardening/security-audit — the result of auditing every networking API. */
export const getSecurityAudit = async (req, res) => {
  try {
    return res.status(200).json({ success: true, audit: await hardeningApi.securityAudit() });
  } catch (error) {
    return handleError(res, error, "getSecurityAudit");
  }
};
