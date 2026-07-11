/**
 * @module replication/delta
 *
 * **Delta replication.** Generates the incremental set of version records a target replica should adopt
 * from a source (replica catch-up), validates + replay-protects deltas, and applies them safely +
 * monotonically. A raw delta apply NEVER overwrites a divergent record — that is the merge engine's job
 * — so delta replication is the safe, resumable catch-up channel; conflicts are reconciled separately.
 *
 * Also carries **transfer-resume metadata**: a delta entry for a large entity (an attachment) references
 * its Layer-8 `transferId` + checkpoint, so an interrupted replication resumes the underlying content
 * transfer from where it left off (via injected transport hooks) rather than restarting.
 *
 * @security A delta carries version records + entity ids + non-secret metadata ONLY. `checksum` +
 * per-record `contentHash` are opaque digests (integrity + divergence detection), not content.
 *
 * @evolution `compressDelta` is an inert seam. Delta ids give REPLAY protection (an applied delta can't
 * be re-applied to forge state); the crypto-level replay resistance stays in Layer 5.
 */

import { ALL_CATEGORIES, DEFAULT_MAX_DELTA_ITEMS, DEFAULT_REPLAY_CACHE_SIZE, StampOrder, isMergeableCategory } from "../types/types.js";
import { compareStamps, hashContent } from "../versions/versionStamp.js";
import { applyRecord } from "../replicas/replicaModel.js";
import { mergeRecords } from "../merge/mergeEngine.js";
import { CorruptedDeltaError, ReplayDetectedError } from "../errors.js";

/**
 * Generate the incremental delta a target should adopt from a source.
 * @param {object} source @param {object} target
 * @param {{ categories?: string[], maxItems?: number, deltaId?: string, cursor?: number, now?: number }} [options]
 * @returns {object} the replication delta
 */
export function generateReplicationDelta(source, target, options = {}) {
  const categories = (options.categories ?? ALL_CATEGORIES).filter((c) => ALL_CATEGORIES.includes(c));
  const maxItems = options.maxItems ?? DEFAULT_MAX_DELTA_ITEMS;
  const records = [];
  let truncated = false;

  outer: for (const category of categories) {
    const sCat = source.categories?.[category] ?? {};
    const tCat = target.categories?.[category] ?? {};
    for (const entityId of Object.keys(sCat).sort()) {
      const s = sCat[entityId];
      const t = tCat[entityId] ?? null;
      const include = !t || (isMergeableCategory(category) ? compareStamps(s, t) !== StampOrder.EQUAL && compareStamps(s, t) !== StampOrder.DOMINATED : compareStamps(s, t) === StampOrder.DOMINATES);
      if (!include) continue;
      if (records.length >= maxItems) {
        truncated = true;
        break outer;
      }
      records.push({ category, record: s });
    }
  }

  const nowIso = new Date(options.now ?? Date.now()).toISOString();
  const delta = {
    deltaId: options.deltaId ?? `delta:${source.replicaId}->${target.replicaId}:${records.length}:${nowIso}`,
    sourceReplicaId: source.replicaId,
    targetReplicaId: target.replicaId,
    categories,
    records,
    totalItems: records.length,
    partial: truncated,
    cursor: options.cursor ?? 0,
    createdAt: nowIso,
    schemaVersion: 1,
  };
  delta.checksum = deltaChecksum(delta);
  return delta;
}

/** A stable checksum over a delta's ordered records (integrity + determinism). */
export function deltaChecksum(delta) {
  const material = (delta.records ?? []).map((r) => `${r.category}:${r.record.entityId}@${r.record.version}#${r.record.contentHash}`).join("|");
  return hashContent(material);
}

/** Validate a delta's shape + integrity checksum. @throws {CorruptedDeltaError} */
export function validateDelta(delta) {
  if (!delta || !Array.isArray(delta.records)) throw new CorruptedDeltaError("delta is malformed");
  for (const r of delta.records) {
    if (!r || typeof r.category !== "string" || !r.record || typeof r.record.entityId !== "string" || !Number.isFinite(r.record.version)) {
      throw new CorruptedDeltaError("delta contains a malformed record", { details: { record: r } });
    }
    if (!ALL_CATEGORIES.includes(r.category)) throw new CorruptedDeltaError(`delta references unknown category "${r.category}"`);
  }
  if (delta.checksum && delta.checksum !== deltaChecksum(delta)) throw new CorruptedDeltaError("delta checksum mismatch (corrupted / tampered)");
  return delta;
}

/** Inert placeholder — delta compression. Returns the delta unchanged (Sprint 3+ fills this). */
export function compressDelta(delta) {
  return delta;
}

/**
 * Apply a delta to a target snapshot. Mergeable categories merge into the existing record; others adopt
 * monotonically (a dominated/divergent record is skipped, never overwriting). Pure. @returns {{ snapshot, applied, skipped }}
 */
export function applyDelta(target, delta, options = {}) {
  validateDelta(delta);
  const records = options.fromCursor ? delta.records.slice(options.fromCursor) : delta.records;
  let snapshot = target;
  let applied = 0;
  let skipped = 0;
  for (const { category, record } of records) {
    if (isMergeableCategory(category)) {
      const existing = snapshot.categories?.[category]?.[record.entityId] ?? null;
      const merged = existing ? mergeRecords(category, existing, record) : record;
      const before = existing?.contentHash;
      snapshot = setInto(snapshot, category, merged);
      if (merged.contentHash !== before) applied++;
      else skipped++;
    } else {
      const res = applyRecord(snapshot, category, record);
      snapshot = res.snapshot;
      res.changed ? applied++ : skipped++;
    }
  }
  return { snapshot, applied, skipped };
}

/** Remaining delta records from a resume cursor (partial-transfer / interrupted-replication resume). */
export function resumeDelta(delta, cursor = 0) {
  const resumed = { ...delta, records: (delta.records ?? []).slice(cursor), cursor, resumedFrom: cursor };
  resumed.checksum = deltaChecksum(resumed); // recompute over the sliced records so it re-validates
  return resumed;
}

/**
 * Build transfer-resume metadata for the LARGE entities in a delta (attachments / transfer metadata),
 * so an interrupted replication resumes their Layer-8 content transfers rather than restarting.
 * @param {object} delta @param {{ transferHooks?: { resume?: Function }, now?: number }} [options]
 * @returns {{ resumable: boolean, transfers: object[], recovery: object }}
 */
export function planTransferResume(delta, options = {}) {
  const transfers = [];
  for (const { category, record } of delta.records ?? []) {
    if ((category === "attachments" || category === "transfer-metadata") && record.meta?.transferId) {
      const entry = { entityId: record.entityId, transferId: record.meta.transferId, checkpoint: record.meta.checkpoint ?? null, size: record.meta.size ?? null };
      if (options.transferHooks?.resume) {
        try {
          entry.plan = options.transferHooks.resume(entry);
        } catch {
          entry.plan = null;
        }
      }
      transfers.push(entry);
    }
  }
  return { resumable: transfers.length > 0, transfers, recovery: { deltaId: delta.deltaId, cursor: delta.cursor ?? 0, at: new Date(options.now ?? Date.now()).toISOString() } };
}

/**
 * A bounded replay guard: an applied delta id cannot be applied again (prevents replaying an old delta
 * to forge state). LRU-bounded.
 */
export class ReplayGuard {
  constructor(options = {}) {
    this._limit = options.size ?? DEFAULT_REPLAY_CACHE_SIZE;
    this._seen = new Map();
  }
  /** @returns {boolean} true if newly seen; throws if a replay. @throws {ReplayDetectedError} */
  check(deltaId) {
    if (this._seen.has(deltaId)) throw new ReplayDetectedError(`Delta "${deltaId}" was already applied`, { details: { deltaId } });
    this._seen.set(deltaId, 1);
    while (this._seen.size > this._limit) this._seen.delete(this._seen.keys().next().value);
    return true;
  }
  has(deltaId) {
    return this._seen.has(deltaId);
  }
  reset() {
    this._seen.clear();
  }
}

/** @private set a record into a snapshot immutably. */
function setInto(snapshot, category, record) {
  const categories = { ...snapshot.categories, [category]: { ...(snapshot.categories?.[category] ?? {}), [record.entityId]: record } };
  return { ...snapshot, categories };
}
