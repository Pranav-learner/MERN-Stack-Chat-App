/**
 * @module replication/conflicts/detector
 *
 * **Conflict detection.** Compares two replicas entity-by-entity and classifies each pairing: only on
 * one side (replicate), identical (in sync), a fast-forward (one side is strictly newer → catch up),
 * a mergeable pairing (lossless union/max), or a genuine CONFLICT (concurrent divergent edits that a
 * policy must resolve). Deterministic — sorted iteration, pure.
 *
 * @security Operates on version records + ids only — never content.
 *
 * @distributed Detection is where "eventual consistency" begins: comparing state (not operations) means
 * two replicas that exchange comparisons converge regardless of message ordering.
 */

import { ALL_CATEGORIES, ComparisonOutcome, StampOrder, isMergeableCategory } from "../types/types.js";
import { compareStamps } from "../versions/versionStamp.js";

/**
 * Classify a single entity across two replicas.
 * @param {string} category @param {object|null} source @param {object|null} target
 * @returns {{ outcome: string }}
 */
export function classifyEntity(category, source, target) {
  if (source && !target) return { outcome: ComparisonOutcome.ONLY_IN_SOURCE };
  if (!source && target) return { outcome: ComparisonOutcome.ONLY_IN_TARGET };
  if (!source && !target) return { outcome: ComparisonOutcome.IN_SYNC };
  // Both present.
  if (isMergeableCategory(category)) {
    // Mergeable categories are lossless — a union/max merge unless already identical.
    if (compareStamps(source, target) === StampOrder.EQUAL) return { outcome: ComparisonOutcome.IN_SYNC };
    return { outcome: ComparisonOutcome.MERGE };
  }
  switch (compareStamps(source, target)) {
    case StampOrder.EQUAL:
      return { outcome: ComparisonOutcome.IN_SYNC };
    case StampOrder.DOMINATES:
      return { outcome: ComparisonOutcome.FAST_FORWARD_TARGET };
    case StampOrder.DOMINATED:
      return { outcome: ComparisonOutcome.FAST_FORWARD_SOURCE };
    default:
      return { outcome: ComparisonOutcome.CONFLICT };
  }
}

/**
 * Compare two replica snapshots. @param {object} source @param {object} target @param {{ categories?: string[] }} [options]
 * @returns {{ perCategory: object, conflicts: object[], merges: object[], totals: object }}
 */
export function compareReplicas(source, target, options = {}) {
  const categories = (options.categories ?? ALL_CATEGORIES).filter((c) => ALL_CATEGORIES.includes(c));
  const perCategory = {};
  const conflicts = [];
  const merges = [];
  const totals = { inSync: 0, onlyInSource: 0, onlyInTarget: 0, fastForwardTarget: 0, fastForwardSource: 0, conflicts: 0, merges: 0 };

  for (const category of categories) {
    const sCat = source.categories?.[category] ?? {};
    const tCat = target.categories?.[category] ?? {};
    const entityIds = [...new Set([...Object.keys(sCat), ...Object.keys(tCat)])].sort();
    const bucket = { inSync: 0, onlyInSource: [], onlyInTarget: [], fastForwardTarget: [], fastForwardSource: [], conflicts: [], merges: [] };

    for (const entityId of entityIds) {
      const s = sCat[entityId] ?? null;
      const t = tCat[entityId] ?? null;
      const { outcome } = classifyEntity(category, s, t);
      switch (outcome) {
        case ComparisonOutcome.IN_SYNC:
          bucket.inSync++;
          totals.inSync++;
          break;
        case ComparisonOutcome.ONLY_IN_SOURCE:
          bucket.onlyInSource.push(entityId);
          totals.onlyInSource++;
          break;
        case ComparisonOutcome.ONLY_IN_TARGET:
          bucket.onlyInTarget.push(entityId);
          totals.onlyInTarget++;
          break;
        case ComparisonOutcome.FAST_FORWARD_TARGET:
          bucket.fastForwardTarget.push(entityId);
          totals.fastForwardTarget++;
          break;
        case ComparisonOutcome.FAST_FORWARD_SOURCE:
          bucket.fastForwardSource.push(entityId);
          totals.fastForwardSource++;
          break;
        case ComparisonOutcome.MERGE:
          bucket.merges.push(entityId);
          totals.merges++;
          merges.push({ category, entityId, source: s, target: t, outcome });
          break;
        case ComparisonOutcome.CONFLICT:
          bucket.conflicts.push(entityId);
          totals.conflicts++;
          conflicts.push({ category, entityId, source: s, target: t, outcome, metadata: { sourceVersion: s.version, targetVersion: t.version, sourceWriter: s.writerReplicaId, targetWriter: t.writerReplicaId } });
          break;
        default:
          break;
      }
    }
    perCategory[category] = bucket;
  }

  return { perCategory, conflicts, merges, totals };
}
