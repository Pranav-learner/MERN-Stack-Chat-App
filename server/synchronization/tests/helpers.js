/**
 * Shared test helpers for the synchronization (Layer 9, Sprint 1) suite. DB-free — everything runs
 * under `node --test` with an in-memory repository + a deterministic clock + id generator.
 */

import { SynchronizationManager } from "../manager/synchronizationManager.js";
import { createInMemorySyncRepository } from "../repository/inMemorySyncRepository.js";
import { SyncEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export function makeIdGen(prefix = "id") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** Build category-versions from a compact `{ category: { entityId: version } }` map. */
export function versions(map) {
  const out = {};
  for (const [category, entities] of Object.entries(map)) out[category] = { entities };
  return out;
}

/** A version map with `count` messages m1..mN all at version 1 (for large-history tests). */
export function manyMessages(count, startVersion = 1) {
  const entities = {};
  for (let i = 1; i <= count; i++) entities[`m${i}`] = startVersion;
  return { messages: { entities } };
}

export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemorySyncRepository();
  const events = new SyncEventBus();
  const manager = new SynchronizationManager({ ...repo, events, clock: clock.now, idGenerator: options.idGen ?? makeIdGen(), batchSize: options.batchSize ?? 10, sessionTtlMs: options.sessionTtlMs });
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, repo, events, clock, captured };
}

/** Drive a session to completion by repeatedly dispensing + applying operations. */
export async function drain(manager, sessionId, { max = 5 } = {}) {
  let guard = 0;
  while (guard++ < 10_000) {
    const ops = await manager.getNextOperations({ sessionId, max });
    if (ops.length === 0) break;
    await manager.recordProgress({ sessionId, appliedOpIds: ops.map((o) => o.opId) });
  }
  return manager.getStatus(sessionId);
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}
