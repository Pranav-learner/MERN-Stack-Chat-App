/**
 * @module endpoint-selection/policies
 *
 * **Selection policies** — named scoring-weight profiles that steer the {@link module:endpoint-selection/scorer
 * scoring engine} toward different optimization goals. A policy is just a set of dimension weights
 * plus optional context hints (`preferType`, whether it needs a `preferredPlatform` /
 * `preferredDeviceId`). Because scoring is a weighted average, a policy needs only to express
 * *relative* weights — the engine normalizes.
 *
 * @networking Different call sites optimize for different things: "just give me the best link"
 * (highest-score), "the device the user is actually at" (most-recently-active), "don't wake the
 * phone" (battery-friendly / desktop-preferred). All are deterministic and reproducible.
 */

import { SelectionPolicy, ScoringDimension, DeviceType } from "../types/types.js";

const D = ScoringDimension;

/**
 * Built-in weight profiles. Each is `{ name, weights, preferType? }`. Weights are relative; the
 * engine normalizes by their sum. Future dimensions (networkQuality/natType) are omitted (weight 0)
 * so they stay inert until a later sprint enables them.
 */
export const POLICY_PROFILES = Object.freeze({
  [SelectionPolicy.HIGHEST_SCORE]: {
    name: SelectionPolicy.HIGHEST_SCORE,
    weights: { [D.PRESENCE]: 3, [D.CAPABILITY]: 3, [D.PROTOCOL]: 1, [D.SECURITY]: 2, [D.RELIABILITY]: 2, [D.PRIORITY]: 1, [D.PLATFORM]: 1, [D.USER_PREFERENCE]: 1, [D.RECENCY]: 1 },
  },
  [SelectionPolicy.MOST_RECENTLY_ACTIVE]: {
    name: SelectionPolicy.MOST_RECENTLY_ACTIVE,
    weights: { [D.RECENCY]: 5, [D.PRESENCE]: 3, [D.CAPABILITY]: 2, [D.RELIABILITY]: 1 },
  },
  [SelectionPolicy.PREFERRED_PLATFORM]: {
    name: SelectionPolicy.PREFERRED_PLATFORM,
    weights: { [D.PLATFORM]: 5, [D.CAPABILITY]: 3, [D.PRESENCE]: 3, [D.RELIABILITY]: 1 },
  },
  [SelectionPolicy.LOWEST_LATENCY]: {
    // FUTURE: real latency. Inert today — networkQuality is neutral, so this behaves like a
    // capability/presence-weighted score with a deterministic tie-break.
    name: SelectionPolicy.LOWEST_LATENCY,
    weights: { [D.CAPABILITY]: 3, [D.PRESENCE]: 3, [D.NETWORK_QUALITY]: 2, [D.RECENCY]: 1 },
  },
  [SelectionPolicy.BATTERY_FRIENDLY]: {
    // Prefer likely-plugged-in (desktop) endpoints to spare mobile battery.
    name: SelectionPolicy.BATTERY_FRIENDLY,
    weights: { [D.DEVICE_TYPE]: 4, [D.PRESENCE]: 3, [D.CAPABILITY]: 2, [D.RELIABILITY]: 1 },
    preferType: DeviceType.DESKTOP,
  },
  [SelectionPolicy.DESKTOP_PREFERRED]: {
    name: SelectionPolicy.DESKTOP_PREFERRED,
    weights: { [D.DEVICE_TYPE]: 5, [D.CAPABILITY]: 3, [D.PRESENCE]: 3 },
    preferType: DeviceType.DESKTOP,
  },
  [SelectionPolicy.MOBILE_PREFERRED]: {
    name: SelectionPolicy.MOBILE_PREFERRED,
    weights: { [D.DEVICE_TYPE]: 5, [D.CAPABILITY]: 3, [D.PRESENCE]: 3 },
    preferType: DeviceType.MOBILE,
  },
  [SelectionPolicy.MANUAL_PREFERENCE]: {
    // Pin the requested device (userPreference dominates), still requiring it be reachable + capable.
    name: SelectionPolicy.MANUAL_PREFERENCE,
    weights: { [D.USER_PREFERENCE]: 8, [D.PRESENCE]: 2, [D.CAPABILITY]: 2 },
  },
});

/**
 * Resolve a policy into a concrete `{ name, weights, preferType?, extraDimensions? }` profile.
 * Accepts a policy name, or a `{ name:"custom", weights, preferType?, dimensions? }` object.
 * Unknown names fall back to `HIGHEST_SCORE`.
 *
 * @param {string|object} [policy]
 * @param {object} [overrides] runtime overrides (e.g. `{ weights }` merged onto the profile)
 * @returns {{ name: string, weights: Record<string, number>, preferType?: string, extraDimensions?: object }}
 */
export function resolvePolicy(policy, overrides = {}) {
  let profile;
  if (!policy) {
    profile = POLICY_PROFILES[SelectionPolicy.HIGHEST_SCORE];
  } else if (typeof policy === "string") {
    profile = POLICY_PROFILES[policy] ?? POLICY_PROFILES[SelectionPolicy.HIGHEST_SCORE];
  } else if (policy && typeof policy === "object") {
    // A custom policy object: use its weights (+ optional custom dimension functions).
    profile = {
      name: policy.name ?? SelectionPolicy.CUSTOM,
      weights: policy.weights ?? POLICY_PROFILES[SelectionPolicy.HIGHEST_SCORE].weights,
      preferType: policy.preferType,
      extraDimensions: policy.dimensions,
    };
  } else {
    profile = POLICY_PROFILES[SelectionPolicy.HIGHEST_SCORE];
  }
  const weights = overrides.weights ? { ...profile.weights, ...overrides.weights } : { ...profile.weights };
  return { name: profile.name, weights, preferType: overrides.preferType ?? profile.preferType, extraDimensions: profile.extraDimensions };
}

/** Whether a policy name is a known built-in. */
export function isKnownPolicy(policy) {
  return typeof policy === "string" && policy in POLICY_PROFILES;
}
