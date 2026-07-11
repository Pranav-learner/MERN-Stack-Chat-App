/**
 * @module pdp/repositories/inMemory
 *
 * In-memory PDP repositories: the reference for the repository contract and the test/device
 * backend. Bundles the two stores the protocol needs:
 *
 * - `sessions` — PDP workflow sessions (state, stage, audit, history).
 * - `plans` — connection plans (the protocol's output), keyed by planId + discoveryId.
 *
 * Records are deep-copied on the way in and out. Imports no driver, so the whole stack runs under
 * `node --test`.
 *
 * ## Session store contract (shared with Mongo)
 * - `create(session) -> session` · `findById(discoveryId) -> session | null`
 * - `update(discoveryId, patch) -> session` · `delete(discoveryId) -> boolean`
 * - `findActiveByDedupeKey(key) -> session | null`
 * - `listByRequester(requester, { activeOnly, limit }) -> session[]`
 * - `listExpired(nowIso) -> session[]`
 *
 * ## Plan store contract (shared with Mongo)
 * - `create(plan) -> plan` · `findById(planId) -> plan | null`
 * - `findByDiscoveryId(discoveryId) -> plan | null` · `delete(planId) -> boolean`
 * - `listByRequester(requester, { limit }) -> plan[]`
 */

import { PdpNotFoundError } from "../errors.js";
import { ACTIVE_PDP_STATES } from "../types/types.js";
import { pdpDedupeKey } from "../workflow/session.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const ACTIVE = new Set(ACTIVE_PDP_STATES);

/** @returns {{ sessions: object, plans: object, reset: () => void }} */
export function createInMemoryPdpRepository() {
  /** @type {Map<string, object>} discoveryId -> session */
  const sessionsById = new Map();
  /** @type {Map<string, object>} planId -> plan */
  const plansById = new Map();
  /** @type {Map<string, string>} discoveryId -> planId */
  const planByDiscovery = new Map();

  const sessions = {
    async create(session) {
      sessionsById.set(session.discoveryId, clone(session));
      return clone(session);
    },
    async findById(discoveryId) {
      const s = sessionsById.get(String(discoveryId));
      return s ? clone(s) : null;
    },
    async update(discoveryId, patch) {
      const key = String(discoveryId);
      const existing = sessionsById.get(key);
      if (!existing) throw new PdpNotFoundError("Discovery session not found", { details: { discoveryId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      sessionsById.set(key, clone(updated));
      return clone(updated);
    },
    async delete(discoveryId) {
      return sessionsById.delete(String(discoveryId));
    },
    async findActiveByDedupeKey(dedupeKey) {
      for (const s of sessionsById.values()) {
        if (ACTIVE.has(s.state) && pdpDedupeKey(s) === dedupeKey) return clone(s);
      }
      return null;
    },
    async listByRequester(requester, options = {}) {
      const rid = String(requester);
      let list = [...sessionsById.values()].filter((s) => s.requester === rid && (!options.activeOnly || ACTIVE.has(s.state)));
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...sessionsById.values()]
        .filter((s) => ACTIVE.has(s.state) && s.expiresAt && new Date(s.expiresAt).getTime() <= now)
        .map(clone);
    },
  };

  const plans = {
    async create(plan) {
      plansById.set(plan.planId, clone(plan));
      if (plan.discoveryId) planByDiscovery.set(String(plan.discoveryId), plan.planId);
      return clone(plan);
    },
    async findById(planId) {
      const p = plansById.get(String(planId));
      return p ? clone(p) : null;
    },
    async findByDiscoveryId(discoveryId) {
      const id = planByDiscovery.get(String(discoveryId));
      const p = id ? plansById.get(id) : null;
      return p ? clone(p) : null;
    },
    async delete(planId) {
      const p = plansById.get(String(planId));
      if (p?.discoveryId) planByDiscovery.delete(String(p.discoveryId));
      return plansById.delete(String(planId));
    },
    async listByRequester(requester, options = {}) {
      const rid = String(requester);
      let list = [...plansById.values()].filter((p) => p.requester === rid);
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  return {
    sessions,
    plans,
    reset: () => {
      sessionsById.clear();
      plansById.clear();
      planByDiscovery.clear();
    },
  };
}
