/**
 * @module transport-engine/priorities
 *
 * **Priority model + starvation prevention.** Every transfer carries a priority (critical control >
 * chat > image > voice-note > document > file > background). The scheduler favours higher-weight
 * transfers, but a purely greedy policy would starve low-priority transfers forever — so a waiting
 * chunk's EFFECTIVE weight grows with its age (linear aging). Past a threshold even a background
 * transfer out-weighs a fresh high-priority one, guaranteeing forward progress for all.
 *
 * @distributed Aging is the classic anti-starvation technique from OS schedulers, applied to transfer
 * multiplexing: bounded priority inversion in exchange for guaranteed liveness.
 */

import { PRIORITY_WEIGHT, TransferPriority, DEFAULT_STARVATION_AGE_MS } from "../types/types.js";

/** The base scheduling weight of a priority (higher = sooner). Unknown → FILE weight. */
export function priorityWeight(priority) {
  return PRIORITY_WEIGHT[priority] ?? PRIORITY_WEIGHT[TransferPriority.FILE];
}

/**
 * The effective weight of a ready chunk, including an aging boost so nothing starves. A chunk that has
 * waited `waitMs` gains `waitMs / agingMs` full "priority tiers" of boost.
 * @param {string} priority @param {number} waitMs how long the chunk has been ready @param {object} [options]
 * @returns {number}
 */
export function effectiveWeight(priority, waitMs, options = {}) {
  const agingMs = options.agingMs ?? DEFAULT_STARVATION_AGE_MS;
  const boostPerTier = options.boostPerTier ?? PRIORITY_WEIGHT[TransferPriority.CHAT];
  const boost = agingMs > 0 ? (Math.max(0, waitMs) / agingMs) * boostPerTier : 0;
  return priorityWeight(priority) + boost;
}

/** Comparator (descending effective weight; ties broken by longer wait, then lower index). */
export function compareCandidates(a, b, now, options = {}) {
  const wa = effectiveWeight(a.priority, now - (a.readySince ?? now), options);
  const wb = effectiveWeight(b.priority, now - (b.readySince ?? now), options);
  if (wa !== wb) return wb - wa;
  const ageA = now - (a.readySince ?? now);
  const ageB = now - (b.readySince ?? now);
  if (ageA !== ageB) return ageB - ageA;
  return (a.index ?? 0) - (b.index ?? 0);
}

/** Whether a chunk has aged past the starvation threshold (diagnostics / boosting hint). */
export function isStarving(readySince, now, agingMs = DEFAULT_STARVATION_AGE_MS) {
  return now - (readySince ?? now) >= agingMs;
}
