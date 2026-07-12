/**
 * @module group/versions
 *
 * **Group version management.** A group is a versioned distributed entity: it carries a VERSION VECTOR
 * of independent monotonic counters — one per facet (group / membership / metadata / role / permission /
 * replica). Any mutation bumps the aggregate `group` counter plus the specific facet's counter, so a
 * device (or a future synchronizer) can tell exactly WHICH facet changed and by how much without
 * diffing the whole entity.
 *
 * @evolution This sprint uses SCALAR counters — a linear model compatible with Layer 9 Sprint 1's
 * `entityId → number` version maps. `bumpVersion` + `versionHistoryEntry` are the seams a FUTURE
 * vector-clock / group-replication hybrid drops into WITHOUT changing callers. It does NOT implement
 * vector clocks, CRDTs, or consensus.
 *
 * @security A version vector + history entry carry counters + facet names + actor ids + timestamps ONLY
 * — never content or keys.
 */

import { VersionKind, ALL_VERSION_KINDS } from "../types/types.js";
import { GroupValidationError } from "../errors.js";

/** A fresh version vector (every facet at 1). Pure. @returns {import("../types/types.js").VersionVector} */
export function createVersionVector() {
  return { group: 1, membership: 1, metadata: 1, role: 1, permission: 1, replica: 1 };
}

/** Normalize a possibly-partial vector into a full one (defaults each facet to 1). */
export function normalizeVersionVector(vector = {}) {
  const base = createVersionVector();
  const out = { ...base };
  for (const kind of ALL_VERSION_KINDS) {
    const v = vector[kind];
    if (Number.isFinite(v) && v >= 1) out[kind] = Math.floor(v);
  }
  return out;
}

/**
 * Bump a facet's counter (and always the aggregate `group` counter). Returns a NEW vector — pure, so
 * callers keep the previous vector for history. @param {import("../types/types.js").VersionVector} vector
 * @param {string} kind one of {@link VersionKind} @returns {import("../types/types.js").VersionVector}
 */
export function bumpVersion(vector, kind) {
  if (!ALL_VERSION_KINDS.includes(kind)) throw new GroupValidationError(`Unknown version kind "${kind}"`, { details: { kind } });
  const base = normalizeVersionVector(vector);
  const next = { ...base, group: base.group + 1 };
  if (kind !== VersionKind.GROUP) next[kind] = base[kind] + 1;
  return next;
}

/**
 * Compare two version vectors facet-by-facet. Returns `"equal"` | `"ahead"` (a strictly dominates b on
 * every facet) | `"behind"` | `"diverged"` (each ahead on some facet — a genuine concurrent conflict).
 * This is the seam a future replication hybrid uses to reconcile group replicas.
 */
export function compareVersionVectors(a, b) {
  const va = normalizeVersionVector(a);
  const vb = normalizeVersionVector(b);
  let aAhead = false;
  let bAhead = false;
  for (const kind of ALL_VERSION_KINDS) {
    if (va[kind] > vb[kind]) aAhead = true;
    else if (va[kind] < vb[kind]) bAhead = true;
  }
  if (aAhead && bAhead) return "diverged";
  if (aAhead) return "ahead";
  if (bAhead) return "behind";
  return "equal";
}

/** Assert an expected version matches (optimistic concurrency). Skipped when `expected` is nullish. */
export function assertVersionMatch(expected, actual, kind = VersionKind.GROUP) {
  if (expected == null) return true;
  if (Number(expected) !== Number(actual)) {
    throw new GroupValidationError(`Stale ${kind} version`, { details: { expected, actual, kind } });
  }
  return true;
}

/**
 * A compact version-history entry describing one facet bump. @param {object} params
 * @param {string} params.kind facet {@link VersionKind} @param {number} params.from @param {number} params.to
 * @param {string} [params.actorId] who caused the bump @param {string} [params.reason] short cause
 * @param {string} [params.at] ISO timestamp
 */
export function versionHistoryEntry({ kind, from, to, actorId, reason, at }) {
  return { kind, from, to, actorId: actorId ?? null, reason: reason ?? null, at: at ?? new Date().toISOString() };
}

export { VersionKind, ALL_VERSION_KINDS };
