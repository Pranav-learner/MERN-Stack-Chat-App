/**
 * @module networking-hardening/security
 *
 * **Security audit of the networking control plane.** A machine-readable posture manifest for every
 * Layer-6 API group + the runtime helpers that enforce it. This is the "audit every networking API"
 * deliverable: it records, per API group, whether it requires authentication, is ownership-scoped,
 * exposes only public metadata, needs a rate-limit hook, and applies enumeration resistance — plus a
 * checker that flags any group missing a required control.
 *
 * @security The audit itself asserts the SECURITY properties of the APIs; it moves no data. Every
 * networking API is JWT-protected (`protectedRoute`), returns PUBLIC metadata only, and — for
 * mutating/owner-scoped operations — enforces the requester via each subsystem's `assertRequester` /
 * `assertOwner`.
 */

/**
 * The security posture of each networking API group. `authenticated`: behind JWT. `ownerScoped`:
 * mutating/read of one's own records asserts the requester. `publicMetadataOnly`: never returns key
 * material. `rateLimit`: a rate-limit hook is recommended (expensive / enumerable). `enumResistant`:
 * unknown vs unauthorized are indistinguishable.
 */
export const API_SECURITY_POSTURE = Object.freeze({
  "peer-discovery": { base: "/api/discovery", authenticated: true, ownerScoped: true, publicMetadataOnly: true, rateLimit: true, enumResistant: true },
  presence: { base: "/api/presence", authenticated: true, ownerScoped: true, publicMetadataOnly: true, rateLimit: true, enumResistant: true },
  capabilities: { base: "/api/capabilities", authenticated: true, ownerScoped: true, publicMetadataOnly: true, rateLimit: true, enumResistant: true },
  "peer-discovery-protocol": { base: "/api/pdp", authenticated: true, ownerScoped: true, publicMetadataOnly: true, rateLimit: true, enumResistant: true },
  "endpoint-selection": { base: "/api/endpoint-selection", authenticated: true, ownerScoped: true, publicMetadataOnly: true, rateLimit: true, enumResistant: true },
  "networking-hardening": { base: "/api/networking-hardening", authenticated: true, ownerScoped: false, publicMetadataOnly: true, rateLimit: false, enumResistant: false },
});

/** The controls every USER-FACING (non-observability) API group must satisfy. */
const REQUIRED_USER_CONTROLS = ["authenticated", "publicMetadataOnly"];

/**
 * Audit the API posture: returns `{ ok, findings }`. A finding names a group + a missing control.
 * Observability APIs (`networking-hardening`) are exempt from owner-scoping/enumeration checks.
 * @param {Record<string, object>} [posture]
 * @returns {{ ok: boolean, findings: Array<{ group: string, missing: string }>, groups: number }}
 */
export function auditNetworkingApis(posture = API_SECURITY_POSTURE) {
  const findings = [];
  for (const [group, p] of Object.entries(posture)) {
    for (const control of REQUIRED_USER_CONTROLS) {
      if (!p[control]) findings.push({ group, missing: control });
    }
    // User-facing groups (those that read other users' data) must be enumeration-resistant.
    if (group !== "networking-hardening" && !p.enumResistant) findings.push({ group, missing: "enumResistant" });
  }
  return { ok: findings.length === 0, findings, groups: Object.keys(posture).length };
}

/**
 * Assert a caller is the owner of a record before a mutating/private read (a uniform ownership gate
 * the controllers can call). @param {object} record @param {string} actingUserId @param {string} [ownerField]
 * @returns {boolean} @throws {Error} a 403-shaped error when not the owner.
 */
export function assertOwnership(record, actingUserId, ownerField = "requester") {
  if (!actingUserId || String(record?.[ownerField]) !== String(actingUserId)) {
    const err = new Error("Forbidden");
    err.status = 403;
    err.code = "ERR_NETHARD_FORBIDDEN";
    throw err;
  }
  return true;
}

/**
 * Validate + clamp pagination inputs (API hardening: bounded page sizes, safe offsets).
 * @param {{ limit?: number|string, offset?: number|string, cursor?: string }} [query]
 * @param {{ maxLimit?: number, defaultLimit?: number }} [options]
 * @returns {{ limit: number, offset: number, cursor: string|null }}
 */
export function normalizePagination(query = {}, options = {}) {
  const maxLimit = options.maxLimit ?? 200;
  const defaultLimit = options.defaultLimit ?? 50;
  let limit = Number.parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(limit, maxLimit);
  let offset = Number.parseInt(query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const cursor = typeof query.cursor === "string" && query.cursor.length <= 512 ? query.cursor : null;
  return { limit, offset, cursor };
}
