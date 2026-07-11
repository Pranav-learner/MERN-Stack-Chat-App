/**
 * @module synchronization-reliability/security
 *
 * **Security audit + documented assumptions** for the synchronization layer (Step 7). A machine-
 * readable posture manifest for the synchronization / replication / reliability APIs + the security
 * assumptions the layer makes, plus helpers (ownership gate, pagination clamp, a rate-limit extension
 * point, and an operation-audit shaper).
 *
 * @security This module asserts SECURITY properties of the synchronization layer; it moves no data. The
 * core guarantees: the layer reasons over VERSION METADATA ONLY (no plaintext/content/keys anywhere);
 * every API is JWT-authenticated + owner-scoped so only a user's own device may register/compare/
 * synchronize/recover its replica; deltas are replay-protected (a delta id can't be re-applied); and
 * merges are deterministic + owner-authorized. The encrypted content is transported + integrity-checked
 * by Layer 8, and replay resistance at the crypto level lives in Layer 5.
 */

import { ReliabilityValidationError, UnauthorizedReliabilityError } from "../errors.js";

/** The security posture of each synchronization API group. */
export const API_SECURITY_POSTURE = Object.freeze({
  synchronization: { base: "/api/synchronization", authenticated: true, ownerScoped: true, metadataOnly: true, replayProtected: true, rateLimit: true },
  replication: { base: "/api/replication", authenticated: true, ownerScoped: true, metadataOnly: true, replayProtected: true, rateLimit: true },
  "synchronization-reliability": { base: "/api/sync-reliability", authenticated: true, ownerScoped: true, metadataOnly: true, replayProtected: true, rateLimit: true },
});

/** Documented security ASSUMPTIONS the synchronization layer relies on (surfaced by the API + docs). */
export const SECURITY_ASSUMPTIONS = Object.freeze([
  { topic: "synchronization-authorization", assumption: "Every synchronization API is JWT-authenticated; a device may only register/compare/synchronize/recover its OWN replica (owner-scoped by device + user)." },
  { topic: "replica-authorization", assumption: "A replica is bound to its authenticated device + user; the reliability + replication layers' ownership scoping prevents a different principal from adopting or recovering it." },
  { topic: "encrypted-metadata-integrity", assumption: "The layer reasons over VERSION METADATA only (versions, ids, counts, opaque content hashes) — never plaintext or content. The content itself is encrypted (Layers 2–5) + integrity-checked when transported (Layer 8)." },
  { topic: "replay-protection", assumption: "A replication delta id cannot be re-applied (the ReplayGuard), and a resume re-runs only the remaining operations from a monotonic checkpoint — a replay cannot forge or rewind replica state. Cryptographic replay resistance lives in Layer 5." },
  { topic: "merge-authorization", assumption: "A merge is owner-scoped + deterministic; the same conflict resolves to the same winner on every replica, so no principal can bias convergence." },
  { topic: "recovery-authorization", assumption: "Recovery is owner-scoped; a resume is initiated by the owning device, never a third party, and preserves replica consistency (checkpoint intact)." },
  { topic: "rate-limiting", assumption: "Sync / recover / resume endpoints expose a rate-limit extension point to blunt sync-storm abuse." },
]);

const REQUIRED_CONTROLS = ["authenticated", "ownerScoped", "metadataOnly", "replayProtected"];

/** Audit the API posture: `{ ok, findings, groups, assumptions }`. */
export function auditSyncApis(posture = API_SECURITY_POSTURE) {
  const findings = [];
  for (const [group, p] of Object.entries(posture)) {
    for (const control of REQUIRED_CONTROLS) if (!p[control]) findings.push({ group, missing: control });
  }
  return { ok: findings.length === 0, findings, groups: Object.keys(posture).length, assumptions: SECURITY_ASSUMPTIONS };
}

/** Assert a caller owns a record (uniform ownership gate). @throws {UnauthorizedReliabilityError} */
export function assertOwnership(record, actingDeviceId) {
  const id = String(actingDeviceId);
  if (!actingDeviceId || (id !== String(record?.deviceId) && id !== String(record?.userId))) {
    throw new UnauthorizedReliabilityError("Caller does not own this synchronization", { details: { syncId: record?.syncId } });
  }
  return true;
}

/** Validate + clamp pagination inputs (API hardening). */
export function normalizePagination(query = {}, options = {}) {
  const maxLimit = options.maxLimit ?? 200;
  const defaultLimit = options.defaultLimit ?? 50;
  let limit = Number.parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(limit, maxLimit);
  let offset = Number.parseInt(query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

/** A pluggable rate-limit EXTENSION POINT (default: no-op allow; fail-open). */
export function makeRateLimitGate(options = {}) {
  const limiter = options.limiter ?? null;
  return (key) => {
    if (!limiter) return { allowed: true };
    try {
      return limiter(key);
    } catch {
      return { allowed: true };
    }
  };
}

/** Shape a synchronization operation into an audit entry (no content/keys). */
export function auditOperation({ operation, syncId, replicaId, actingDevice, outcome, at, details }) {
  if (!operation) throw new ReliabilityValidationError("audit operation requires { operation }");
  return { operation, syncId: syncId ?? null, replicaId: replicaId ?? null, actingDevice: actingDevice ?? null, outcome: outcome ?? "ok", at: at ?? new Date().toISOString(), details: details ?? {} };
}
