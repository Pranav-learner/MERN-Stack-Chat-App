/**
 * @module network-reliability/health
 *
 * **Connection health monitoring.** Computes a continuous, deterministic HEALTH SCORE for a
 * connection from its latency, stability (missed heartbeats + reconnects), recent activity, and age,
 * and maps it to a {@link HealthStatus}. Also carries inert placeholders for packet loss + jitter
 * (no media-quality monitoring in this sprint).
 *
 * @security Health is derived from CONTROL-PLANE signals (latencies, counters, timestamps) — no key
 * material. Health computation is pure + side-effect-free.
 *
 * @networking A single score lets the manager (and Layer 8) reason about a connection at a glance:
 * `healthy` = use it; `degraded` = watch/plan a recovery; `unhealthy` = recover now.
 */

import { HealthStatus, HEALTH_WEIGHTS, LATENCY_CEILING_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS } from "../types/types.js";

/** Map a numeric score `[0,1]` to a {@link HealthStatus}. */
export function scoreToStatus(score) {
  if (!Number.isFinite(score)) return HealthStatus.UNKNOWN;
  if (score >= 0.7) return HealthStatus.HEALTHY;
  if (score >= 0.4) return HealthStatus.DEGRADED;
  return HealthStatus.UNHEALTHY;
}

/** Latency dimension: fast → 1, at/above the ceiling → 0. */
function latencyDim(latencyMs) {
  if (latencyMs == null || !Number.isFinite(latencyMs)) return 0.5; // no sample yet → neutral
  return Math.max(0, 1 - Math.min(latencyMs, LATENCY_CEILING_MS) / LATENCY_CEILING_MS);
}

/** Stability dimension: fewer missed heartbeats + reconnects → 1. */
function stabilityDim(missedHeartbeats, reconnectCount) {
  const penalty = (missedHeartbeats ?? 0) + (reconnectCount ?? 0) * 0.5;
  return Math.max(0, 1 - Math.min(penalty, 6) / 6);
}

/** Activity dimension: recent activity → 1, decays over ~3× the heartbeat timeout. */
function activityDim(sinceActivityMs, timeoutMs) {
  if (sinceActivityMs == null) return 0.5;
  const window = (timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS) * 3;
  return Math.max(0, 1 - Math.min(sinceActivityMs, window) / window);
}

/** Age dimension: a connection that has survived a while is more trusted, capped at 60s. */
function ageDim(ageMs) {
  if (ageMs == null) return 0;
  return Math.min(ageMs, 60_000) / 60_000;
}

/**
 * Compute a connection's health from its raw signals.
 *
 * @param {object} params
 * @param {number} [params.latencyMs] last measured RTT
 * @param {number} [params.missedHeartbeats] @param {number} [params.reconnectCount]
 * @param {number} [params.ageMs] time since established @param {number} [params.sinceActivityMs] time since last activity
 * @param {number} [params.timeoutMs] heartbeat timeout @param {string} [params.lastHeartbeatAt]
 * @returns {import("../types/types.js").ConnectionHealth}
 */
export function computeHealth(params) {
  const latency = latencyDim(params.latencyMs);
  const stability = stabilityDim(params.missedHeartbeats, params.reconnectCount);
  const activity = activityDim(params.sinceActivityMs, params.timeoutMs);
  const age = ageDim(params.ageMs);

  const score =
    HEALTH_WEIGHTS.latency * latency +
    HEALTH_WEIGHTS.stability * stability +
    HEALTH_WEIGHTS.activity * activity +
    HEALTH_WEIGHTS.age * age;
  const rounded = Number(score.toFixed(4));

  return {
    status: scoreToStatus(rounded),
    score: rounded,
    latencyMs: params.latencyMs ?? null,
    packetLoss: null, // FUTURE placeholder — no media-quality monitoring in this sprint
    jitterMs: null, // FUTURE placeholder
    stability: Number(stability.toFixed(4)),
    missedHeartbeats: params.missedHeartbeats ?? 0,
    reconnectCount: params.reconnectCount ?? 0,
    lastHeartbeatAt: params.lastHeartbeatAt ?? null,
    ageMs: params.ageMs ?? 0,
    breakdown: { latency: Number(latency.toFixed(3)), stability: Number(stability.toFixed(3)), activity: Number(activity.toFixed(3)), age: Number(age.toFixed(3)) },
  };
}

/**
 * Compute health for an {@link ActiveConnection} record at a given time (convenience wrapper).
 * @param {object} connection @param {number} now @param {number} [timeoutMs] @returns {object}
 */
export function healthForConnection(connection, now, timeoutMs) {
  const established = connection.establishedAt ? new Date(connection.establishedAt).getTime() : now;
  const lastActivity = connection.lastActivityAt ? new Date(connection.lastActivityAt).getTime() : established;
  const lastHeartbeat = connection.health?.lastHeartbeatAt ? new Date(connection.health.lastHeartbeatAt).getTime() : lastActivity;
  return computeHealth({
    latencyMs: connection.health?.latencyMs,
    missedHeartbeats: connection.health?.missedHeartbeats ?? 0,
    reconnectCount: connection.reconnectCount ?? 0,
    ageMs: Math.max(0, now - established),
    sinceActivityMs: Math.max(0, now - Math.max(lastActivity, lastHeartbeat)),
    timeoutMs,
    lastHeartbeatAt: connection.health?.lastHeartbeatAt ?? null,
  });
}
