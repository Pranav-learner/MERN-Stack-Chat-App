/**
 * @module group-reliability/security
 *
 * **Security audit + documented assumptions** for the whole Layer 10 Group Communication platform
 * (Step 7). A machine-readable posture manifest for the group / membership / messaging / key /
 * reliability APIs, plus the security assumptions the platform makes, plus helpers (an ownership gate, a
 * pagination clamp, a rate-limit extension point, and an operation-audit shaper). "Audit every group
 * operation" is realized by the manager recording an audit entry (via {@link auditOperation}) on every
 * mutating reliability op.
 *
 * @security This module asserts SECURITY properties of the group layer; it moves no data. The core
 * guarantees: every group API is JWT-authenticated + owner/member-scoped; membership + admin + role
 * enforcement live in the Sprint-1 Group Manager (RBAC by rank + permission); group-key authorization +
 * membership rekeying live in the Sprint-2 engine (keys are device-local, the server sees only
 * fingerprints); synchronization is owner-scoped + resumes only from a monotonic checkpoint (no replay
 * can rewind state); and cryptographic replay resistance lives in Layer 5. This reliability layer adds
 * per-operation ownership scoping + a uniform audit trail.
 */

import { ReliabilityValidationError, UnauthorizedReliabilityError } from "../errors.js";

/** The security posture of each group-platform API group. */
export const API_SECURITY_POSTURE = Object.freeze({
  "group-management": { base: "/api/group-management", authenticated: true, ownerScoped: true, roleEnforced: true, metadataOnly: true, rateLimit: true },
  "group-communication": { base: "/api/group-communication", authenticated: true, ownerScoped: true, memberScoped: true, metadataOnly: true, blindRelay: true, rateLimit: true },
  "group-reliability": { base: "/api/group-reliability", authenticated: true, ownerScoped: true, metadataOnly: true, auditEvery: true, rateLimit: true },
});

/** Documented security ASSUMPTIONS the group platform relies on (surfaced by the API + docs). */
export const SECURITY_ASSUMPTIONS = Object.freeze([
  { topic: "membership-authorization", assumption: "Every group API is JWT-authenticated; only an active member may read a group, and only a member with the right role/permission may mutate it (Sprint-1 RBAC by rank + configurable permissions)." },
  { topic: "admin-authorization", assumption: "Administrative operations (invite/remove/ban/mute, role change, metadata edit, permission override, ownership transfer) are gated by rank + permission in the Sprint-1 Group Manager; an actor can only manage strictly-lower-ranked members." },
  { topic: "role-enforcement", assumption: "Roles are ranked (owner > admin > moderator > member > guest) and enforced on every mutation; owner-only permissions (delete/transfer/manage-permissions) can never be granted to another role." },
  { topic: "group-key-authorization", assumption: "Group keys are DEVICE-LOCAL (HKDF, Layer 5); the platform stores only opaque fingerprints + versions. A rekey on member departure uses fresh randomness so a departed member cannot derive the next epoch. The server never sees a key." },
  { topic: "synchronization-authorization", assumption: "Group synchronization + reliability recovery are owner-scoped; a device may only register/checkpoint/recover its OWN group operations, and a resume re-runs only remaining targets from a monotonic checkpoint." },
  { topic: "replay-protection", assumption: "A resume re-runs only remaining targets from a monotonic checkpoint — a replay cannot forge or rewind operation progress. Delivery is at-most-once per device (Sprint-2 DeliveryGuard). Cryptographic replay resistance lives in Layer 5." },
  { topic: "api-authorization", assumption: "All reliability endpoints are JWT-authenticated + owner-scoped; reads return control-plane metadata + numeric aggregates only (no content/keys)." },
  { topic: "rate-limiting", assumption: "Send / recover / resume / rekey endpoints expose a rate-limit extension point to blunt group-storm abuse." },
  { topic: "audit", assumption: "Every mutating group-reliability operation is recorded to an append-only audit trail (operation, ids, actor, outcome) — no content or keys." },
]);

const REQUIRED_CONTROLS = ["authenticated", "ownerScoped", "metadataOnly"];

/** Audit the API posture: `{ ok, findings, groups, assumptions }`. */
export function auditGroupApis(posture = API_SECURITY_POSTURE) {
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
    throw new UnauthorizedReliabilityError("Caller does not own this group operation", { details: { operationId: record?.operationId } });
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

/** Shape a group operation into an audit entry (no content/keys). */
export function auditOperation({ operation, operationId, groupId, actingDevice, outcome, at, details }) {
  if (!operation) throw new ReliabilityValidationError("audit operation requires { operation }");
  return { operation, operationId: operationId ?? null, groupId: groupId ?? null, actingDevice: actingDevice ?? null, outcome: outcome ?? "ok", at: at ?? new Date().toISOString(), details: details ?? {} };
}
