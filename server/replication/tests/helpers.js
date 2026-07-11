/**
 * Shared test helpers for the replication (Layer 9, Sprint 2) suite. DB-free — everything runs under
 * `node --test` with an in-memory repository + a deterministic clock + id generator.
 */

import { ReplicaManager } from "../manager/replicaManager.js";
import { createInMemoryReplicationRepository } from "../repository/inMemoryReplicationRepository.js";
import { ReplicationEventBus } from "../events/events.js";
import { createReplicaSnapshot } from "../replicas/replicaModel.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export function makeIdGen(prefix = "id") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** Build an entity version record. */
export function rec(version, writer, hash, updatedAt, meta) {
  return { version, writerReplicaId: writer, contentHash: hash ?? `h${version}`, updatedAt: updatedAt ?? new Date(1_700_000_000_000).toISOString(), ...(meta !== undefined ? { meta } : {}) };
}

/** Build a replica snapshot directly (for pure-function tests). */
export function snapshot(replicaId, categories, clock = makeClock().now) {
  return createReplicaSnapshot({ replicaId, deviceId: replicaId, userId: "u1", categories, clock });
}

export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryReplicationRepository();
  const events = new ReplicationEventBus();
  const manager = new ReplicaManager({ ...repo, events, clock: clock.now, idGenerator: options.idGen ?? makeIdGen(), authorityReplicaId: options.authorityReplicaId, policies: options.policies, customResolvers: options.customResolvers, transferHooks: options.transferHooks });
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, repo, events, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}
