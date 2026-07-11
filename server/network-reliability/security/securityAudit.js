/**
 * @module network-reliability/security
 *
 * **Security audit + documented assumptions** for the connectivity layer (Step 7). A machine-
 * readable posture manifest for the connection/recovery APIs + the security assumptions the layer
 * makes, plus helpers (ownership gate, pagination clamp).
 *
 * @security This subsystem asserts SECURITY properties of the connectivity APIs; it moves no data.
 * The core continuity guarantee is: a reconnect resumes the SAME cryptographic `sessionId` — so
 * forward-secret keys survive a network blip — and a resumed session inherits the crypto layer's
 * REPLAY resistance (per-message keys + replay windows from Layer 5), so a reconnect cannot replay
 * old ciphertext. Connection hijacking is prevented by ownership scoping (only the owning device may
 * mutate/recover a connection) layered on top of the authenticated handshake that created the session.
 */

/** The security posture of each connectivity API group. */
export const API_SECURITY_POSTURE = Object.freeze({
  "network-discovery": { base: "/api/network-discovery", authenticated: true, ownerScoped: true, publicMetadataOnly: true, rateLimit: true },
  "network-reliability": { base: "/api/network-reliability", authenticated: true, ownerScoped: true, publicMetadataOnly: true, rateLimit: true },
});

/**
 * Documented security ASSUMPTIONS the reliability layer relies on (surfaced by the API + docs).
 */
export const SECURITY_ASSUMPTIONS = Object.freeze([
  { topic: "connection-authorization", assumption: "Every connection API is JWT-authenticated; only the owning device may inspect/mutate/recover a connection." },
  { topic: "recovery-authorization", assumption: "Recovery is owner-scoped; a reconnect is initiated by the owning device, never by a third party." },
  { topic: "session-continuity", assumption: "A reconnect resumes the SAME sessionId (a transport reconnect, not a new handshake) so forward-secret keys survive; a full re-handshake is only used when the session cannot resume." },
  { topic: "replay-resistance", assumption: "A resumed session inherits the Layer-5 per-message keys + replay windows, so reconnecting cannot replay prior ciphertext. The reliability layer never carries message content or keys." },
  { topic: "connection-hijacking", assumption: "A connection is bound to its authenticated device + session; the reliability layer's ownership scoping prevents a different principal from adopting or recovering it." },
  { topic: "connection-metadata", assumption: "Connection records are PUBLIC control-plane metadata (ids, states, latencies) — no key material, no message content." },
  { topic: "rate-limiting", assumption: "Recover/reconnect endpoints expose a rate-limit extension point to blunt reconnect-storm abuse." },
]);

/** The controls every connectivity API group must satisfy. */
const REQUIRED_CONTROLS = ["authenticated", "ownerScoped", "publicMetadataOnly"];

/**
 * Audit the API posture: `{ ok, findings, assumptions }`.
 * @param {Record<string, object>} [posture] @returns {object}
 */
export function auditConnectivityApis(posture = API_SECURITY_POSTURE) {
  const findings = [];
  for (const [group, p] of Object.entries(posture)) {
    for (const control of REQUIRED_CONTROLS) if (!p[control]) findings.push({ group, missing: control });
  }
  return { ok: findings.length === 0, findings, groups: Object.keys(posture).length, assumptions: SECURITY_ASSUMPTIONS };
}

/** Assert a caller owns a record (uniform ownership gate). @throws a 403-shaped error. */
export function assertOwnership(record, actingDeviceId, deviceField = "deviceId") {
  if (!actingDeviceId || String(record?.[deviceField]) !== String(actingDeviceId)) {
    const err = new Error("Forbidden");
    err.status = 403;
    err.code = "ERR_NETREL_FORBIDDEN";
    throw err;
  }
  return true;
}

/**
 * Validate + clamp pagination inputs (API hardening).
 * @param {{ limit?: number|string, offset?: number|string }} [query] @param {{ maxLimit?: number, defaultLimit?: number }} [options]
 * @returns {{ limit: number, offset: number }}
 */
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
