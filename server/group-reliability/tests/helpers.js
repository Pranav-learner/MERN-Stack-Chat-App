/**
 * Shared test helpers for the Group Reliability (Layer 10, Sprint 3) suite. DB-free — everything runs
 * under `node --test` with an in-memory repository + a deterministic clock + id generator + injected
 * recovery hooks, so the tests never import mongoose.
 */

import { GroupReliabilityManager } from "../manager/groupReliabilityManager.js";
import { createInMemoryGroupReliabilityRepository } from "../repository/inMemoryGroupReliabilityRepository.js";
import { createGroupReliabilityApi } from "../api/reliabilityApi.js";
import { GroupReliabilityEventBus } from "../events/events.js";
import { GroupMetrics } from "../monitoring/metrics.js";
import { GroupMonitor } from "../monitoring/groupMonitor.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export function makeIdGen(prefix = "op") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** Build a manager + api over an in-memory repo with metrics + monitor + a captured event log. */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryGroupReliabilityRepository();
  const events = new GroupReliabilityEventBus();
  const metrics = new GroupMetrics({ clock: clock.now });
  const monitor = new GroupMonitor({ events, metrics, sink: repo.alerts, clock: clock.now, windowMs: options.windowMs, thresholds: options.thresholds });
  const manager = new GroupReliabilityManager({
    ...repo,
    events,
    metrics,
    monitor,
    clock: clock.now,
    idGenerator: options.idGen ?? makeIdGen(),
    retryPolicy: options.retryPolicy,
    stallTimeoutMs: options.stallTimeoutMs,
    backlogThreshold: options.backlogThreshold,
    recoveryHooks: options.recoveryHooks,
  });
  const api = createGroupReliabilityApi(manager, { metrics, monitor, alerts: repo.alerts, audit: repo.audit });
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, api, repo, events, metrics, monitor, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** Register a fan-out operation with `total` targets. */
export async function seedOperation(manager, overrides = {}) {
  return manager.registerOperation({ operationId: overrides.operationId ?? "op:1", groupId: overrides.groupId ?? "g1", operationType: overrides.operationType ?? "fan-out", deviceId: overrides.deviceId ?? "alice", totalTargets: overrides.totalTargets ?? 40, ...overrides });
}
