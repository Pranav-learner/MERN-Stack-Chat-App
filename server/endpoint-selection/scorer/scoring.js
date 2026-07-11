/**
 * @module endpoint-selection/scorer
 *
 * The **Device Scoring Engine** — deterministic, extensible, multi-dimensional scoring of candidate
 * endpoints. Each scoring DIMENSION is a pure function returning a value in `[0,1]`; a policy
 * assigns each dimension a weight and the engine returns the weighted average. New dimensions plug
 * in without changing callers (pass `extraDimensions`), so the system is EXTENSIBLE by design.
 *
 * @networking Scoring must be **deterministic + reproducible**: given the same candidate + context +
 * weights it always yields the same score, and ranking breaks ties by `deviceId` ascending. That is
 * what lets two nodes independently agree on the optimal endpoint.
 *
 * @security Scores are derived from PUBLIC signals only (presence status, negotiated capabilities,
 * public versions, historical success counts, declared priority). No key material is read.
 *
 * Dimensions (all `[0,1]`):
 * - `presence`      — online > away > busy > invisible (reachability quality)
 * - `capability`    — compatible + richness of the negotiated capability surface
 * - `protocol`      — protocol version height
 * - `security`      — crypto compatibility (+ meets a required minimum)
 * - `platform`      — matches a preferred platform
 * - `userPreference`— matches a preferred device
 * - `reliability`   — historical success ratio (Laplace-smoothed)
 * - `priority`      — declared device priority
 * - `recency`       — how recently the device was active
 * - `deviceType`    — matches a preferred form factor (desktop/mobile)
 * - `networkQuality`, `natType` — FUTURE placeholders (inert/neutral)
 */

import { DeviceType, ScoringDimension } from "../types/types.js";
import { compareVersions, parseVersion, isValidVersion } from "../../capabilities/version/version.js";

/** Presence statuses in which an endpoint is genuinely reachable (a hard gate for selection). */
const REACHABLE = new Set(["online", "away", "busy", "invisible"]);

/** Infer a device's form factor from an explicit `deviceType` or its platform string. */
export function inferDeviceType(candidate) {
  const explicit = candidate?.deviceType;
  if (explicit === DeviceType.DESKTOP || explicit === DeviceType.MOBILE) return explicit;
  const p = String(candidate?.platform ?? "").toLowerCase();
  if (/(ios|android|mobile|phone|tablet)/.test(p)) return DeviceType.MOBILE;
  if (/(web|desktop|windows|mac|macos|linux|electron)/.test(p)) return DeviceType.DESKTOP;
  return DeviceType.UNKNOWN;
}

/** Whether a candidate is reachable (presence gate). */
export function isReachable(candidate) {
  return REACHABLE.has(candidate?.presenceStatus);
}

// ── individual dimension functions (pure, [0,1]) ────────────────────────────

function presenceScore(c) {
  switch (c?.presenceStatus) {
    case "online": return 1;
    case "away": return 0.8;
    case "busy": return 0.65;
    case "invisible": return 0.55;
    case "reconnecting": return 0.3;
    default: return 0;
  }
}

function capabilityScore(c) {
  const cap = c?.capabilities ?? {};
  if (!cap.compatible) return 0;
  let s = 0.4; // base for being compatible at all
  const shared = Array.isArray(cap.sharedTransports) ? cap.sharedTransports.length : 0;
  s += (Math.min(shared, 4) / 4) * 0.3;
  if (["webrtc", "quic"].includes(cap.preferredTransport)) s += 0.15;
  else if (cap.preferredTransport) s += 0.08;
  if (cap.compression && cap.compression !== "none") s += 0.05;
  const flags = cap.featureFlags ? Object.keys(cap.featureFlags).length : 0;
  s += (Math.min(flags, 5) / 5) * 0.1;
  return Math.min(1, s);
}

function protocolScore(c) {
  const v = c?.capabilities?.protocolVersion;
  if (!v || !isValidVersion(v)) return 0;
  const [major = 0, minor = 0] = parseVersion(v);
  return Math.min(1, (major + minor / 10) / 2); // "1.0" → 0.5, "2.0" → 1
}

function securityScore(c, ctx) {
  const v = c?.capabilities?.cryptoVersion;
  if (!v || !isValidVersion(v)) return 0;
  const min = ctx?.securityRequirements?.minCryptoVersion;
  if (min && isValidVersion(min) && compareVersions(v, min) < 0) return 0;
  const [major = 0, minor = 0] = parseVersion(v);
  return Math.min(1, 0.6 + (major + minor / 10) / 5);
}

function platformScore(c, ctx) {
  if (!ctx?.preferredPlatform) return 0.5; // neutral when no preference
  return c?.platform === ctx.preferredPlatform ? 1 : 0;
}

function userPreferenceScore(c, ctx) {
  if (!ctx?.preferredDeviceId) return 0.5;
  return c?.deviceId === ctx.preferredDeviceId ? 1 : 0;
}

function reliabilityScore(c, ctx) {
  const r = ctx?.reliability?.[c?.deviceId];
  if (!r) return 0.5; // neutral with no history
  const s = r.successes ?? 0;
  const f = r.failures ?? 0;
  return (s + 1) / (s + f + 2); // Laplace-smoothed success ratio
}

function priorityScore(c) {
  if (c?.priority == null) return 0.5;
  return Math.max(0, Math.min(1, c.priority / 100));
}

function recencyScore(c, ctx) {
  const t = c?.lastSeen ? new Date(c.lastSeen).getTime() : 0;
  if (!t) return 0;
  const ageMs = Math.max(0, (ctx?.now ?? Date.now()) - t);
  return Math.max(0, 1 - ageMs / 300_000); // decays over 5 minutes
}

function deviceTypeScore(c, ctx) {
  if (!ctx?.preferType) return 0.5;
  return inferDeviceType(c) === ctx.preferType ? 1 : 0.3;
}

/** FUTURE placeholders — inert/neutral until a later sprint fills them. */
function neutralFuture() {
  return 0.5;
}

/** The built-in dimension function table. */
export const DIMENSION_FUNCTIONS = Object.freeze({
  [ScoringDimension.PRESENCE]: presenceScore,
  [ScoringDimension.CAPABILITY]: capabilityScore,
  [ScoringDimension.PROTOCOL]: protocolScore,
  [ScoringDimension.SECURITY]: securityScore,
  [ScoringDimension.PLATFORM]: platformScore,
  [ScoringDimension.USER_PREFERENCE]: userPreferenceScore,
  [ScoringDimension.RELIABILITY]: reliabilityScore,
  [ScoringDimension.PRIORITY]: priorityScore,
  [ScoringDimension.RECENCY]: recencyScore,
  [ScoringDimension.DEVICE_TYPE]: deviceTypeScore,
  [ScoringDimension.NETWORK_QUALITY]: neutralFuture, // FUTURE
  [ScoringDimension.NAT_TYPE]: neutralFuture, // FUTURE
});

/**
 * Score a single candidate endpoint.
 *
 * @param {object} candidate an {@link EndpointCandidate}
 * @param {object} ctx scoring context `{ now, reliability, preferredPlatform, preferredDeviceId, preferType, securityRequirements }`
 * @param {Record<string, number>} weights dimension → weight (only weight>0 dimensions count)
 * @param {Record<string, (c:object, ctx:object)=>number>} [extraDimensions] custom dimension fns
 * @returns {{ score: number, breakdown: Record<string, number>, eligible: boolean, ineligibleReason: string|null }}
 */
export function scoreEndpoint(candidate, ctx, weights, extraDimensions = {}) {
  const fns = { ...DIMENSION_FUNCTIONS, ...extraDimensions };
  const breakdown = {};
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [dim, weight] of Object.entries(weights ?? {})) {
    if (!weight || weight <= 0) continue;
    const fn = fns[dim];
    if (typeof fn !== "function") continue;
    const value = clamp01(fn(candidate, ctx));
    breakdown[dim] = Number(value.toFixed(4));
    weightedSum += value * weight;
    totalWeight += weight;
  }
  const score = totalWeight === 0 ? 0 : weightedSum / totalWeight;

  // Hard eligibility gates (a candidate can score but still be ineligible to be primary).
  let eligible = true;
  let ineligibleReason = null;
  if (!isReachable(candidate)) {
    eligible = false;
    ineligibleReason = "no-reachable-endpoint";
  } else if (!candidate?.capabilities?.compatible) {
    eligible = false;
    ineligibleReason = "capability-mismatch";
  } else if (ctx?.securityRequirements?.minCryptoVersion) {
    const v = candidate?.capabilities?.cryptoVersion;
    if (!v || !isValidVersion(v) || compareVersions(v, ctx.securityRequirements.minCryptoVersion) < 0) {
      eligible = false;
      ineligibleReason = "capability-mismatch";
    }
  }

  return { score: Number(score.toFixed(6)), breakdown, eligible, ineligibleReason };
}

/**
 * Score + rank a set of candidates. Eligible endpoints always rank above ineligible ones; within
 * each group, higher score wins and ties break by `deviceId` ascending (deterministic).
 *
 * @param {object[]} candidates @param {object} ctx @param {Record<string, number>} weights
 * @param {Record<string, Function>} [extraDimensions]
 * @returns {import("../types/types.js").ScoredEndpoint[]} ranked, best-first
 */
export function rankEndpoints(candidates, ctx, weights, extraDimensions = {}) {
  const scored = (candidates ?? []).map((candidate) => {
    const { score, breakdown, eligible, ineligibleReason } = scoreEndpoint(candidate, ctx, weights, extraDimensions);
    return { deviceId: candidate.deviceId, score, breakdown, eligible, ineligibleReason, candidate };
  });
  scored.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1; // eligible first
    if (b.score !== a.score) return b.score - a.score; // higher score first
    return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0; // stable tie-break
  });
  return scored.map((s, i) => ({ ...s, rank: i }));
}

/** Clamp a number to `[0,1]` (guards custom dimension functions). */
function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
