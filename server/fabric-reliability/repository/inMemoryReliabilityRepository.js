/**
 * @module fabric-reliability/repository/inMemory
 *
 * In-memory reliability repositories — the reference implementation of the store contracts + the
 * test/device backend (STEP 9). Bundles the three stores the reliability layer needs, storage-independent:
 *
 * - `operations` — fabric operation checkpoints, keyed by operationId.  `upsert · findById · listActive · delete`
 * - `health`     — a bounded ring of health snapshots.  `recordSnapshot · latest · list`
 * - `audit`      — the reliability + security audit trail.  `append · listByOperation · listRecent`
 *
 * Records are deep-copied in + out; no driver, so the whole stack runs under `node --test`. Includes a
 * bounded `cleanup(olderThanMs)` for TTL-style pruning of terminal operations (STEP 9 repository hardening).
 */

const clone = (v) => (v == null ? v : structuredClone(v));
const RING = 1000;
const TERMINAL = new Set(["succeeded", "recovered", "gracefully-failed", "aborted"]);

export function createInMemoryReliabilityRepository() {
  const opsById = new Map();
  const snapshots = [];
  const auditByOp = new Map();
  const auditAll = [];

  const push = (map, key, value) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(value);
  };

  const operations = {
    async upsert(checkpoint) {
      opsById.set(String(checkpoint.operationId), clone(checkpoint));
      return clone(checkpoint);
    },
    async findById(operationId) {
      const c = opsById.get(String(operationId));
      return c ? clone(c) : null;
    },
    async listActive() {
      return [...opsById.values()].filter((c) => !TERMINAL.has(c.state)).map(clone);
    },
    async delete(operationId) {
      return opsById.delete(String(operationId));
    },
    /** TTL cleanup — prune terminal operations older than the cutoff. Returns the number pruned. */
    async cleanup(olderThanMs, now = Date.now()) {
      let pruned = 0;
      for (const [id, c] of opsById) {
        if (TERMINAL.has(c.state) && now - new Date(c.updatedAt ?? c.startedAt).getTime() > olderThanMs) {
          opsById.delete(id);
          pruned++;
        }
      }
      return pruned;
    },
  };

  const health = {
    async recordSnapshot(snapshot) {
      snapshots.push(clone(snapshot));
      if (snapshots.length > RING) snapshots.shift();
      return clone(snapshot);
    },
    async latest() {
      return snapshots.length ? clone(snapshots[snapshots.length - 1]) : null;
    },
    async list({ limit = 100 } = {}) {
      return snapshots.slice(-limit).reverse().map(clone);
    },
  };

  const audit = {
    async append(entry) {
      const rec = clone(entry);
      auditAll.push(rec);
      if (auditAll.length > RING * 5) auditAll.shift();
      if (entry.operationId) push(auditByOp, String(entry.operationId), rec);
      return clone(rec);
    },
    async listByOperation(operationId) {
      return (auditByOp.get(String(operationId)) ?? []).map(clone);
    },
    async listRecent({ limit = 100 } = {}) {
      return auditAll.slice(-limit).reverse().map(clone);
    },
  };

  return {
    operations,
    health,
    audit,
    _counts: () => ({ operations: opsById.size, snapshots: snapshots.length, audit: auditAll.length }),
  };
}
