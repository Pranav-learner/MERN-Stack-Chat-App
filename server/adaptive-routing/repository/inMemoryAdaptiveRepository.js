/**
 * @module adaptive-routing/repository/inMemory
 *
 * In-memory adaptive repositories — the reference implementation of the store contracts + the test/device
 * backend (STEP 10). Bundles the three stores the engine needs, storage-independent:
 *
 * - `capabilities` — negotiated capability profiles, de-duplicated by fingerprint.  `upsert · findByFingerprint`
 * - `evaluations`  — the bundled route evaluation (analysis + ranked route scores + selection + execution
 *   plan + fallback plan + policy decisions).  `create · findByRequest · listRecent`
 * - `audit`        — the adaptive audit trail.  `append · listByRequest`
 *
 * The "Route Scores / Communication Analysis / Execution Plans / Fallback Plans / Policy Decisions" the
 * spec enumerates are all FIELDS of the evaluation record (one addressable unit per request), the same way
 * Sprint-1 folds the execution result onto its plan document. Records are deep-copied in + out; no driver.
 */

const clone = (v) => (v == null ? v : structuredClone(v));

export function createInMemoryAdaptiveRepository() {
  const capabilityByFingerprint = new Map();
  const evaluationsByRequest = new Map(); // requestId → records[]
  const evaluationOrder = []; // { requestId, idx } newest-last
  const auditByRequest = new Map();

  const push = (map, key, value) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(value);
    return list;
  };

  const capabilities = {
    async upsert(profile) {
      capabilityByFingerprint.set(String(profile.fingerprint), clone(profile));
      return clone(profile);
    },
    async findByFingerprint(fingerprint) {
      const p = capabilityByFingerprint.get(String(fingerprint));
      return p ? clone(p) : null;
    },
  };

  const evaluations = {
    async create(record) {
      const list = push(evaluationsByRequest, String(record.requestId), clone(record));
      evaluationOrder.push({ requestId: String(record.requestId), idx: list.length - 1 });
      return clone(record);
    },
    async findByRequest(requestId) {
      const list = evaluationsByRequest.get(String(requestId)) ?? [];
      return list.length ? clone(list[list.length - 1]) : null; // latest
    },
    async listRecent({ limit = 100 } = {}) {
      const refs = evaluationOrder.slice(-limit).reverse();
      return refs.map(({ requestId, idx }) => clone(evaluationsByRequest.get(requestId)[idx]));
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
    capabilities,
    evaluations,
    audit,
    _counts: () => ({ capabilities: capabilityByFingerprint.size, evaluations: evaluationOrder.length }),
  };
}
