/**
 * @module capabilities/version
 *
 * A small, dependency-free **semver-lite** utility for capability version negotiation. Versions
 * are dotted numeric strings — `"1"`, `"1.2"`, `"1.2.3"` — compared component-by-component with
 * missing components treated as `0` (so `"1.0" === "1.0.0"`). This is all the negotiation engine
 * needs: parse, compare, and pick the **highest common** version two devices both support.
 *
 * @networking Deterministic version selection is the backbone of interoperability: both peers,
 * given the same two supported-version sets, must independently arrive at the SAME negotiated
 * version. `highestCommonVersion` guarantees that (it is a pure function of the two sets).
 */

/** Parse a dotted version string into numeric components. Non-numeric parts → NaN-guarded 0. */
export function parseVersion(version) {
  if (typeof version !== "string" || version.length === 0) return null;
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts;
}

/** Whether a string is a valid dotted version. @returns {boolean} */
export function isValidVersion(version) {
  return parseVersion(version) !== null;
}

/**
 * Compare two versions. @returns {number} -1 if a<b, 0 if equal, 1 if a>b. Throws on invalid input.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new TypeError(`Invalid version: ${!pa ? a : b}`);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether two versions are equal (component-wise, ignoring trailing zeros). */
export function versionsEqual(a, b) {
  return compareVersions(a, b) === 0;
}

/**
 * The highest version common to two supported-version sets, or `null` if they are disjoint. Pure
 * + deterministic, so both peers compute the same value.
 * @param {string[]} a @param {string[]} b @returns {string|null}
 */
export function highestCommonVersion(a, b) {
  const setB = new Set((b ?? []).filter(isValidVersion));
  let best = null;
  for (const v of (a ?? []).filter(isValidVersion)) {
    // A version is "common" if the other set contains an equal one (ignoring trailing zeros).
    const match = [...setB].find((w) => versionsEqual(v, w));
    if (match && (best === null || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/** The maximum version in a set (or null). */
export function maxVersion(versions) {
  const valid = (versions ?? []).filter(isValidVersion);
  if (valid.length === 0) return null;
  return valid.reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

/** Normalize a version list: keep valid, dedupe, sort ascending. @returns {string[]} */
export function normalizeVersions(versions) {
  const seen = new Set();
  const valid = [];
  for (const v of versions ?? []) {
    if (isValidVersion(v) && !seen.has(v)) {
      seen.add(v);
      valid.push(v);
    }
  }
  return valid.sort(compareVersions);
}
