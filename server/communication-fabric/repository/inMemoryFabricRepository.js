/**
 * @module communication-fabric/repository/inMemory
 *
 * In-memory Fabric repositories: the reference implementation of the store contracts + the test/device
 * backend. Bundles the four stores the manager needs, storage-independent (STEP 10):
 *
 * - `decisions`  — one record per {@link CommunicationDecision}.   `create · findById · listByRequest`
 * - `plans`      — one record per {@link ExecutionPlan} + its execution result.  `create · findById · update`
 * - `executions` — execution snapshots (result of running a plan).  `create · findById · listRecent`
 * - `audit`      — the audit trail.  `append · listByRequest`
 *
 * Records are deep-copied in + out (structuredClone), so a caller can never mutate stored state. Imports
 * no driver, so the whole Fabric runs under `node --test`.
 */

const clone = (v) => (v == null ? v : structuredClone(v));

export function createInMemoryFabricRepository() {
  const decisionById = new Map();
  const decisionsByRequest = new Map(); // requestId → decisionId[]
  const planById = new Map();
  const executionById = new Map(); // keyed by planId
  const executionOrder = []; // planIds newest-last
  const auditByRequest = new Map(); // requestId → entries[]

  const push = (map, key, value) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(value);
  };

  const decisions = {
    async create(decision) {
      decisionById.set(String(decision.decisionId), clone(decision));
      push(decisionsByRequest, String(decision.requestId), String(decision.decisionId));
      return clone(decision);
    },
    async findById(decisionId) {
      const d = decisionById.get(String(decisionId));
      return d ? clone(d) : null;
    },
    async listByRequest(requestId, { limit } = {}) {
      const ids = decisionsByRequest.get(String(requestId)) ?? [];
      const list = ids.map((id) => decisionById.get(id)).filter(Boolean);
      return (limit ? list.slice(-limit) : list).map(clone);
    },
  };

  const plans = {
    async create(plan) {
      planById.set(String(plan.planId), clone(plan));
      return clone(plan);
    },
    async findById(planId) {
      const p = planById.get(String(planId));
      return p ? clone(p) : null;
    },
    async update(planId, patch) {
      const existing = planById.get(String(planId));
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      planById.set(String(planId), clone(updated));
      return clone(updated);
    },
  };

  const executions = {
    async create(snapshot) {
      const key = String(snapshot.planId);
      if (!executionById.has(key)) executionOrder.push(key);
      executionById.set(key, clone(snapshot));
      return clone(snapshot);
    },
    async findById(planId) {
      const s = executionById.get(String(planId));
      return s ? clone(s) : null;
    },
    async listRecent({ limit = 100 } = {}) {
      const keys = executionOrder.slice(-limit).reverse();
      return keys.map((k) => clone(executionById.get(k)));
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
    decisions,
    plans,
    executions,
    audit,
    // test/diagnostics helpers (not part of the contract)
    _counts: () => ({ decisions: decisionById.size, plans: planById.size, executions: executionById.size }),
  };
}
