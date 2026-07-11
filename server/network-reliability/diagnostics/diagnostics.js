/**
 * @module network-reliability/diagnostics
 *
 * **Connection diagnostics.** Assembles a human/operator-friendly diagnostic snapshot for one
 * connection — its state, health breakdown, transport, reconnect/recovery counts, recent recovery
 * history, and stability summary. Pure; reads what the manager provides.
 *
 * @security Diagnostics are CONTROL-PLANE metadata only — no key material.
 */

import { TransportKind } from "../types/types.js";

/**
 * Build a diagnostics report for a connection.
 * @param {object} connection an {@link ActiveConnection}
 * @param {{ recoveryHistory?: object[], now?: number }} [context]
 * @returns {object}
 */
export function buildDiagnostics(connection, context = {}) {
  const now = context.now ?? Date.now();
  const established = connection.establishedAt ? new Date(connection.establishedAt).getTime() : now;
  const ageMs = Math.max(0, now - established);
  const health = connection.health ?? {};
  return {
    connectionId: connection.connectionId,
    deviceId: connection.deviceId,
    peerId: connection.peerId,
    state: connection.state,
    transport: connection.transport ?? TransportKind.UNKNOWN,
    relayUsed: !!connection.relayUsed,
    sessionPreserved: connection.sessionId != null,
    health: {
      status: health.status ?? "unknown",
      score: health.score ?? 0,
      latencyMs: health.latencyMs ?? null,
      stability: health.stability ?? null,
      missedHeartbeats: health.missedHeartbeats ?? 0,
      breakdown: { ...(health.breakdown ?? {}) },
      packetLoss: health.packetLoss ?? null, // FUTURE placeholder
      jitterMs: health.jitterMs ?? null, // FUTURE placeholder
    },
    counters: {
      reconnectCount: connection.reconnectCount ?? 0,
      recoveryCount: connection.recoveryCount ?? 0,
    },
    ageMs,
    lastActivityAt: connection.lastActivityAt ?? null,
    recoveryHistory: (context.recoveryHistory ?? []).map((r) => ({ trigger: r.trigger, action: r.action, recovered: r.recovered, elapsedMs: r.elapsedMs, at: r.at })),
    generatedAt: new Date(now).toISOString(),
  };
}

/** A one-line stability summary (for lists / logs). */
export function stabilitySummary(connection) {
  const h = connection.health ?? {};
  return `${connection.state} · health=${h.status ?? "?"}(${(h.score ?? 0).toFixed(2)}) · rtt=${h.latencyMs ?? "?"}ms · reconnects=${connection.reconnectCount ?? 0}`;
}
