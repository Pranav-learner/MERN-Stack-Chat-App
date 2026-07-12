/**
 * Shared test helpers for the Media Reliability (Layer 11, Sprint 3) suite. DB-free — everything runs
 * under `node --test` with an in-memory repository + a deterministic clock + id generator + injected
 * recovery hooks, so the tests never import mongoose.
 */

import { MediaReliabilityManager } from "../manager/mediaReliabilityManager.js";
import { createInMemoryMediaReliabilityRepository } from "../repository/inMemoryMediaReliabilityRepository.js";
import { createMediaReliabilityApi } from "../api/reliabilityApi.js";
import { MediaReliabilityEventBus } from "../events/events.js";
import { MediaMetrics } from "../monitoring/metrics.js";
import { MediaMonitor } from "../monitoring/mediaMonitor.js";
import { MediaCache } from "../cache/mediaCache.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export function makeIdGen(prefix = "op") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** Build a manager + api over an in-memory repo with metrics + monitor + cache + a captured event log. */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryMediaReliabilityRepository();
  const events = new MediaReliabilityEventBus();
  const metrics = new MediaMetrics({ clock: clock.now });
  const monitor = new MediaMonitor({ events, metrics, sink: repo.alerts, clock: clock.now, windowMs: options.windowMs, thresholds: options.thresholds });
  const cache = new MediaCache({ clock: clock.now, metrics });
  const manager = new MediaReliabilityManager({
    ...repo,
    events,
    metrics,
    monitor,
    cache,
    clock: clock.now,
    idGenerator: options.idGen ?? makeIdGen(),
    retryPolicy: options.retryPolicy,
    stallTimeoutMs: options.stallTimeoutMs,
    backlogThreshold: options.backlogThreshold,
    recoveryHooks: options.recoveryHooks,
  });
  const api = createMediaReliabilityApi(manager, { metrics, monitor, alerts: repo.alerts, audit: repo.audit });
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, api, repo, events, metrics, monitor, cache, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** Register an upload operation with `chunks` chunks + `bytes` bytes. */
export async function seedOperation(manager, overrides = {}) {
  return manager.registerOperation({ operationId: overrides.operationId ?? "op:1", mediaId: overrides.mediaId ?? "m1", operationType: overrides.operationType ?? "upload", deviceId: overrides.deviceId ?? "alice", totalChunks: overrides.totalChunks ?? 40, bytesTotal: overrides.bytesTotal ?? 10_000_000, ...overrides });
}
