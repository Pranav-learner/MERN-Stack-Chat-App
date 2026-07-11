/**
 * @module pdp/selectors
 *
 * The **Device Selection** engine — deterministic, configurable policies that rank the reachable,
 * capability-compatible candidate devices and choose which one(s) the connection plan targets.
 *
 * @networking Selection is where "many reachable devices" collapses to "the device(s) to connect
 * to". It must be **deterministic + reproducible**: given the same candidates + policy + options,
 * it always produces the same ranking. Every policy therefore breaks ties by `deviceId` ascending,
 * so two nodes computing the same plan agree.
 *
 * Candidates handed to this engine are already reachable (Presence) and capability-compatible
 * (Capability negotiation succeeded), so selection differentiates among *viable* devices — it never
 * has to reason about liveness or compatibility itself.
 */

import {
  SelectionPolicy,
  ALL_SELECTION_POLICIES,
  DEFAULT_MAX_SELECTED_DEVICES,
} from "../types/types.js";

/** Transports considered "direct" (more desirable to prefer) for capability scoring. */
const DIRECT_TRANSPORTS = new Set(["webrtc", "quic"]);

/**
 * Score a candidate by the richness of its NEGOTIATED capabilities (the default policy). Higher =
 * more capable shared surface. Pure; range [0, 1].
 * @param {object} candidate @returns {number}
 */
export function capabilityScore(candidate) {
  const cap = candidate?.capabilities ?? {};
  let score = 0;
  if (cap.protocolVersion) score += 0.2;
  if (cap.cryptoVersion) score += 0.2;
  const shared = Array.isArray(cap.sharedTransports) ? cap.sharedTransports.length : 0;
  score += (Math.min(shared, 4) / 4) * 0.25;
  score += DIRECT_TRANSPORTS.has(cap.preferredTransport) ? 0.1 : cap.preferredTransport ? 0.05 : 0;
  if (cap.compression && cap.compression !== "none") score += 0.05;
  const flags = cap.featureFlags ? Object.keys(cap.featureFlags).length : 0;
  score += (Math.min(flags, 5) / 5) * 0.1;
  if (cap.relay) score += 0.05;
  return Math.min(1, score);
}

/** Recency score from `lastSeen` (most recent → highest), relative to `now`. Range [0, 1]. */
function recencyScore(candidate, now) {
  const t = candidate?.lastSeen ? new Date(candidate.lastSeen).getTime() : 0;
  if (!t) return 0;
  const ageMs = Math.max(0, now - t);
  // Fresh (0 ms) → 1; decays to ~0 over 5 minutes.
  return Math.max(0, 1 - ageMs / 300_000);
}

/**
 * Compute a per-policy score for a candidate. All scores are in [0, 1]; the ranker sorts by score
 * DESC then `deviceId` ASC for stable, reproducible ordering.
 * @param {object} candidate @param {string} policy @param {object} options @param {number} now
 * @returns {number}
 */
export function scoreFor(candidate, policy, options, now) {
  switch (policy) {
    case SelectionPolicy.NEWEST_ACTIVE:
      return recencyScore(candidate, now);
    case SelectionPolicy.HIGHEST_PRIORITY: {
      const priority = options.priorities?.[candidate.deviceId] ?? candidate.priority ?? 0;
      // Normalize an unbounded priority into [0,1] with capability score as a stable tie-breaker.
      return Math.min(1, priority / 100) * 0.9 + capabilityScore(candidate) * 0.1;
    }
    case SelectionPolicy.PLATFORM_PREFERENCE:
      return (candidate.platform && candidate.platform === options.preferredPlatform ? 0.9 : 0) + capabilityScore(candidate) * 0.1;
    case SelectionPolicy.USER_PREFERENCE:
      return (candidate.deviceId === options.preferredDeviceId ? 0.9 : 0) + capabilityScore(candidate) * 0.1;
    case SelectionPolicy.LOWEST_LATENCY:
      // FUTURE: real latency. Inert today — every candidate is equal, so capability score + the
      // deterministic deviceId tie-break decide the order.
      return capabilityScore(candidate) * 0.01;
    case SelectionPolicy.CAPABILITY_SCORE:
    default:
      return capabilityScore(candidate);
  }
}

/**
 * Rank + select devices from a candidate set.
 *
 * @param {object[]} candidates each `{ deviceId, identityId, publicIdentity, presenceStatus,
 *   lastSeen, platform, softwareVersion, capabilities(negotiation result), priority? }`
 * @param {object} [config]
 * @param {string} [config.policy=CAPABILITY_SCORE] one of {@link SelectionPolicy}
 * @param {object} [config.options] policy options (preferredPlatform, preferredDeviceId, priorities)
 * @param {number} [config.maxDevices] cap on selected devices (primary + backups)
 * @param {number} [config.now] epoch ms (for recency policies)
 * @returns {import("../types/types.js").SelectedDevice[]} ranked; index 0 is the primary
 */
export function selectDevices(candidates, config = {}) {
  const policy = ALL_SELECTION_POLICIES.includes(config.policy) ? config.policy : SelectionPolicy.CAPABILITY_SCORE;
  const options = config.options ?? {};
  const maxDevices = config.maxDevices ?? DEFAULT_MAX_SELECTED_DEVICES;
  const now = config.now ?? Date.now();

  const scored = (candidates ?? []).map((c) => ({ candidate: c, score: scoreFor(c, policy, options, now) }));
  // Stable, reproducible order: score DESC, then deviceId ASC.
  scored.sort((a, b) => (b.score - a.score) || (a.candidate.deviceId < b.candidate.deviceId ? -1 : a.candidate.deviceId > b.candidate.deviceId ? 1 : 0));

  return scored.slice(0, maxDevices).map(({ candidate, score }, rank) => ({
    deviceId: candidate.deviceId,
    identityId: candidate.identityId ?? null,
    publicIdentity: candidate.publicIdentity ?? null,
    presenceStatus: candidate.presenceStatus,
    lastSeen: candidate.lastSeen ?? null,
    platform: candidate.platform,
    softwareVersion: candidate.softwareVersion,
    capabilities: candidate.capabilities,
    score: Number(score.toFixed(6)),
    rank,
    priority: Math.max(0, Math.round(score * 100) - rank), // primary keeps the highest priority
  }));
}

/** Validate a selection policy name (falls back to the default). @returns {string} */
export function resolveSelectionPolicy(policy) {
  return ALL_SELECTION_POLICIES.includes(policy) ? policy : SelectionPolicy.CAPABILITY_SCORE;
}
