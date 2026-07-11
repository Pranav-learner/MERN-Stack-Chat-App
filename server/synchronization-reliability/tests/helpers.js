/**
 * Shared test helpers for the synchronization-reliability (Layer 9, Sprint 3) suite. DB-free —
 * everything runs under `node --test` with an in-memory repository + a deterministic clock. Injected
 * hooks are spy-able so recovery flows are observable.
 */

import { SyncReliabilityManager } from "../manager/syncReliabilityManager.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import { SyncMetrics } from "../monitoring/metrics.js";
import { ReliabilityEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryReliabilityRepository();
  const metrics = new SyncMetrics({ clock: clock.now });
  const events = new ReliabilityEventBus();
  const calls = { resume: [], retry: [], restart: [] };
  const recoveryHooks = options.recoveryHooks ?? {
    resumeFromCheckpoint: async (rec, plan) => {
      calls.resume.push({ syncId: rec.syncId, plan });
      return options.resumeResult ?? true;
    },
    retry: async (rec, plan) => {
      calls.retry.push({ syncId: rec.syncId, plan });
      return options.retryResult ?? true;
    },
    restart: async (rec, plan) => {
      calls.restart.push({ syncId: rec.syncId, plan });
      return options.restartResult ?? true;
    },
  };
  const manager = new SyncReliabilityManager({
    ...repo,
    metrics,
    events,
    clock: clock.now,
    retryPolicy: { maxAttempts: 3, retryBudget: 20, recoveryTimeoutMs: 120_000, ...(options.retryPolicy ?? {}) },
    stallTimeoutMs: options.stallTimeoutMs ?? 45_000,
    recoveryHooks,
  });
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, repo, metrics, events, clock, calls, captured };
}

/** Register a sync + advance it to a mid-flight checkpoint. */
export async function seedSync(manager, over = {}) {
  const params = { sessionId: "s1", replicaId: "r1", deviceId: "phone", userId: "u1", totalOperations: 100, ...over };
  await manager.registerSync(params);
  if (over.checkpoint !== null) {
    await manager.checkpoint({ syncId: params.syncId ?? params.sessionId, completedOperations: 40, cursor: 40, conflicts: 2, merges: 3, pendingOperations: 60, replicaDrift: 60, ...(over.checkpoint ?? {}) });
  }
  return params.syncId ?? params.sessionId;
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}
