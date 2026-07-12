/**
 * @module optimization/repository/inMemory
 *
 * In-memory optimization repositories — the reference implementation of the store contracts + the
 * test/device backend (STEP 10). Bundles the three stores the optimizer needs, storage-independent:
 *
 * - `resources`     — a bounded ring of resource snapshots (optimization history).  `recordSnapshot · latest · list`
 * - `optimizations` — the bundled optimization record (QoS + scheduling + allocation + coordination +
 *   balance + optimized plan).  `create · findByRequest · listRecent`
 * - `audit`         — the optimization audit trail.  `append · listByRequest`
 *
 * The "Scheduling / QoS / Resource / Policy metadata + Execution Plans" the spec enumerates are all FIELDS
 * of the optimization record (one addressable unit per request). Records are deep-copied in + out; no driver.
 */

const clone = (v) => (v == null ? v : structuredClone(v));
const RING = 1000;

export function createInMemoryOptimizationRepository() {
  const snapshots = [];
  const optimizationsByRequest = new Map();
  const optimizationOrder = [];
  const auditByRequest = new Map();

  const push = (map, key, value) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(value);
    return list;
  };

  const resources = {
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

  const optimizations = {
    async create(record) {
      const list = push(optimizationsByRequest, String(record.requestId), clone(record));
      optimizationOrder.push({ requestId: String(record.requestId), idx: list.length - 1 });
      return clone(record);
    },
    async findByRequest(requestId) {
      const list = optimizationsByRequest.get(String(requestId)) ?? [];
      return list.length ? clone(list[list.length - 1]) : null;
    },
    async listRecent({ limit = 100 } = {}) {
      return optimizationOrder.slice(-limit).reverse().map(({ requestId, idx }) => clone(optimizationsByRequest.get(requestId)[idx]));
    },
  };

  const audit = {
    async append(entry) {
      push(auditByRequest, String(entry.requestId), clone(entry));
      return clone(entry);
    },
    async listByRequest(requestId) {
      return (auditByRequest.get(String(requestId)) ?? []).map(clone);
    },
  };

  return {
    resources,
    optimizations,
    audit,
    _counts: () => ({ snapshots: snapshots.length, optimizations: optimizationOrder.length }),
  };
}
