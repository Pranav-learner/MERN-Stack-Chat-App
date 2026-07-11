/**
 * Shared test helpers for the transport-reliability (Layer 8, Sprint 3) suite. DB-free — everything
 * runs under `node --test` with an in-memory repository + a deterministic clock. Injected hooks are
 * spy-able so recovery/migration flows are observable.
 */

import { TransportReliabilityManager } from "../manager/transportReliabilityManager.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import { TransferMetrics } from "../monitoring/metrics.js";
import { ReliabilityEventBus } from "../events/events.js";

/** A controllable clock. */
export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/**
 * Build a manager over an in-memory repo with observable hooks + captured events.
 * @param {object} [options] `{ clock?, retryPolicy?, recovery?, migration?, resumeResult?, migrateOk? }`
 */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryReliabilityRepository();
  const metrics = new TransferMetrics({ clock: clock.now });
  const events = new ReliabilityEventBus();
  const calls = { resume: [], retry: [], migrate: [], validate: [], switch: [] };

  const recoveryHooks = options.recovery ?? {
    resumeFromCheckpoint: async (rec, plan) => {
      calls.resume.push({ transferId: rec.transferId, plan });
      return options.resumeResult ?? true;
    },
    retry: async (rec, plan) => {
      calls.retry.push({ transferId: rec.transferId, plan });
      return options.retryResult ?? true;
    },
  };
  const migrationHooks = options.migration ?? {
    validateConnection: async (rec, conn) => {
      calls.validate.push({ transferId: rec.transferId, conn });
      return options.validateOk ?? true;
    },
    switchConnection: async (rec, conn) => {
      calls.switch.push({ transferId: rec.transferId, conn });
      return options.migrateOk ?? true;
    },
  };

  const manager = new TransportReliabilityManager({
    ...repo,
    metrics,
    events,
    clock: clock.now,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, recoveryTimeoutMs: 60_000, ...(options.retryPolicy ?? {}) },
    stallTimeoutMs: options.stallTimeoutMs ?? 20_000,
    recoveryHooks,
    migrationHooks,
  });

  const captured = [];
  events.on("*", (e) => captured.push(e));

  return { manager, repo, metrics, events, clock, calls, captured };
}

/** Register a transfer + advance it to a mid-flight checkpoint. */
export async function seedTransfer(manager, over = {}) {
  const params = { transferId: "t1", conversationId: "c1", senderDeviceId: "alice", receiverDeviceId: "bob", connectionId: "conn-1", totalChunks: 100, ...over };
  await manager.registerTransfer(params);
  if (over.checkpoint !== null) {
    await manager.checkpoint({ transferId: params.transferId, chunksAcked: 40, highWaterMark: 39, bytesTransferred: 2_560_000, outstanding: 4, ...(over.checkpoint ?? {}) });
  }
  return params.transferId;
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}
