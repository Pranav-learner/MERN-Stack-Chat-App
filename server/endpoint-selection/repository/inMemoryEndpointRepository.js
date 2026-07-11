/**
 * @module endpoint-selection/repository/inMemory
 *
 * In-memory Endpoint Selection repositories: the reference for the repository contract and the
 * test/device backend. Bundles the three stores the subsystem needs:
 *
 * - `plans` — the current connection plans (by planId).
 * - `selections` — an append-only selection/routing history (scoring metadata, policy, routing
 *   decisions, audit).
 * - `reliability` — per-(targetUser, deviceId) endpoint history feeding the RELIABILITY dimension.
 *
 * Records are deep-copied on the way in and out. Imports no driver, so the whole stack runs under
 * `node --test`.
 *
 * ## Plan store contract (shared with Mongo)
 * - `create(plan) -> plan` · `findById(planId) -> plan | null` · `update(planId, patch) -> plan`
 * - `delete(planId) -> boolean` · `listByRequester(requester, { limit }) -> plan[]`
 *
 * ## Selection store contract (shared with Mongo)
 * - `record(selection) -> selection` · `findById(selectionId) -> selection | null`
 * - `listByRequester(requester, { limit }) -> selection[]`
 * - `listByTarget(requester, targetUser, { limit }) -> selection[]`
 *
 * ## Reliability store contract (shared with Mongo)
 * - `get(targetUser, deviceId) -> ReliabilityRecord | null`
 * - `getMany(targetUser, deviceIds) -> Record<deviceId, ReliabilityRecord>`
 * - `record(targetUser, deviceId, outcome) -> ReliabilityRecord`
 */

import { EndpointNotFoundError } from "../errors.js";
import { OutcomeType } from "../types/types.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const rkey = (userId, deviceId) => `${userId}|${deviceId}`;

/** @returns {{ plans: object, selections: object, reliability: object, reset: () => void }} */
export function createInMemoryEndpointRepository() {
  /** @type {Map<string, object>} planId -> plan */
  const plansById = new Map();
  /** @type {Map<string, object>} selectionId -> selection */
  const selectionsById = new Map();
  /** @type {Map<string, object>} `${targetUser}|${deviceId}` -> reliability record */
  const reliabilityByKey = new Map();

  const plans = {
    async create(plan) {
      plansById.set(plan.planId, clone(plan));
      return clone(plan);
    },
    async findById(planId) {
      const p = plansById.get(String(planId));
      return p ? clone(p) : null;
    },
    async update(planId, patch) {
      const key = String(planId);
      const existing = plansById.get(key);
      if (!existing) throw new EndpointNotFoundError("Connection plan not found", { details: { planId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      plansById.set(key, clone(updated));
      return clone(updated);
    },
    async delete(planId) {
      return plansById.delete(String(planId));
    },
    async listByRequester(requester, options = {}) {
      const rid = String(requester);
      let list = [...plansById.values()].filter((p) => p.requester === rid);
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  const selections = {
    async record(selection) {
      selectionsById.set(selection.selectionId, clone(selection));
      return clone(selection);
    },
    async findById(selectionId) {
      const s = selectionsById.get(String(selectionId));
      return s ? clone(s) : null;
    },
    async listByRequester(requester, options = {}) {
      const rid = String(requester);
      let list = [...selectionsById.values()].filter((s) => s.requester === rid);
      list.sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listByTarget(requester, targetUser, options = {}) {
      const rid = String(requester);
      const tid = String(targetUser);
      let list = [...selectionsById.values()].filter((s) => s.requester === rid && s.targetUser === tid);
      list.sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  const reliability = {
    async get(targetUser, deviceId) {
      const r = reliabilityByKey.get(rkey(String(targetUser), String(deviceId)));
      return r ? clone(r) : null;
    },
    async getMany(targetUser, deviceIds) {
      const out = {};
      for (const deviceId of deviceIds ?? []) {
        const r = reliabilityByKey.get(rkey(String(targetUser), String(deviceId)));
        if (r) out[deviceId] = clone(r);
      }
      return out;
    },
    async record(targetUser, deviceId, outcome) {
      const key = rkey(String(targetUser), String(deviceId));
      const at = new Date().toISOString();
      const existing = reliabilityByKey.get(key) ?? { targetUser: String(targetUser), deviceId: String(deviceId), successes: 0, failures: 0, lastOutcome: null, lastOutcomeAt: null };
      if (outcome === OutcomeType.SUCCESS) existing.successes += 1;
      else existing.failures += 1;
      existing.lastOutcome = outcome;
      existing.lastOutcomeAt = at;
      existing.reliability = (existing.successes + 1) / (existing.successes + existing.failures + 2);
      reliabilityByKey.set(key, clone(existing));
      return clone(existing);
    },
  };

  return {
    plans,
    selections,
    reliability,
    reset: () => {
      plansById.clear();
      selectionsById.clear();
      reliabilityByKey.clear();
    },
  };
}
