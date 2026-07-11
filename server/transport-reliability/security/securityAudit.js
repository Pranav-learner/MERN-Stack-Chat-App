/**
 * @module transport-reliability/security
 *
 * **Security audit + documented assumptions** for the peer-to-peer Data Plane (Step 7). A machine-
 * readable posture manifest for the messaging / transport / reliability APIs + the security
 * assumptions the Data Plane makes, plus helpers (ownership gate, pagination clamp, a rate-limit
 * extension point, and an operation-audit shaper).
 *
 * @security This module asserts SECURITY properties of the Data Plane; it moves no data. The core
 * guarantees: the Data Plane transports OPAQUE CIPHERTEXT ONLY (no plaintext/keys anywhere); every
 * chunk is integrity-checksummed (corruption/tamper is detected on reassembly); duplicate detection +
 * the Layer-5 per-message keys/replay windows give replay resistance; and every API is JWT-
 * authenticated + owner-scoped so only a transfer's participants can inspect/control/recover it.
 */

import { ReliabilityValidationError, UnauthorizedReliabilityError } from "../errors.js";

/** The security posture of each Data Plane API group. */
export const API_SECURITY_POSTURE = Object.freeze({
  "data-plane": { base: "/api/data-plane", authenticated: true, ownerScoped: true, opaqueCiphertextOnly: true, integrityChecked: true, rateLimit: true },
  "transport-engine": { base: "/api/transport-engine", authenticated: true, ownerScoped: true, opaqueCiphertextOnly: true, integrityChecked: true, rateLimit: true },
  "transport-reliability": { base: "/api/transport-reliability", authenticated: true, ownerScoped: true, opaqueCiphertextOnly: true, integrityChecked: true, rateLimit: true },
});

/** Documented security ASSUMPTIONS the Data Plane relies on (surfaced by the API + docs). */
export const SECURITY_ASSUMPTIONS = Object.freeze([
  { topic: "transfer-authorization", assumption: "Every Data Plane API is JWT-authenticated; only a transfer's participants (sender/receiver) may relay, pull, control, or recover it (owner-scoped)." },
  { topic: "encrypted-payload-integrity", assumption: "Payloads are ALREADY encrypted (Layers 2–5); the Data Plane carries opaque ciphertext, and every chunk + the whole payload is SHA-256 integrity-checksummed so corruption or tampering is detected on reassembly." },
  { topic: "chunk-validation", assumption: "Every inbound chunk is validated for shape + ordering + integrity before storage; a mismatched checksum is rejected (no ACK) and retransmitted." },
  { topic: "replay-protection", assumption: "Transport-level duplicate detection (message/chunk caches) makes delivery at-most-once; cryptographic replay resistance (per-message keys + replay windows) lives in Layer 5. Recovery/resume re-send only missing chunks and cannot inject replays past the dedup + crypto windows." },
  { topic: "transfer-metadata", assumption: "Transfer + chunk records are PUBLIC control-plane metadata (ids, counts, sizes, checksums, states) — never plaintext or key material. The no-plaintext deep scan is enforced before every persist + wire build." },
  { topic: "recovery-authorization", assumption: "Recovery + migration are owner-scoped and preserve the crypto session; a migration is a transport swap, never a re-handshake, so forward-secret keys survive a network change." },
  { topic: "rate-limiting", assumption: "Relay / recover / migrate endpoints expose a rate-limit extension point to blunt abuse (chunk-flood, recovery-storm)." },
]);

const REQUIRED_CONTROLS = ["authenticated", "ownerScoped", "opaqueCiphertextOnly", "integrityChecked"];

/**
 * Audit the API posture: `{ ok, findings, groups, assumptions }`.
 * @param {Record<string, object>} [posture] @returns {object}
 */
export function auditDataPlaneApis(posture = API_SECURITY_POSTURE) {
  const findings = [];
  for (const [group, p] of Object.entries(posture)) {
    for (const control of REQUIRED_CONTROLS) if (!p[control]) findings.push({ group, missing: control });
  }
  return { ok: findings.length === 0, findings, groups: Object.keys(posture).length, assumptions: SECURITY_ASSUMPTIONS };
}

/** Assert a caller participates in a transfer (sender or receiver). @throws {UnauthorizedReliabilityError} */
export function assertParticipant(record, actingDeviceId) {
  const id = String(actingDeviceId);
  if (!actingDeviceId || (id !== String(record?.senderDeviceId) && id !== String(record?.receiverDeviceId))) {
    throw new UnauthorizedReliabilityError("Caller is not a participant in this transfer", { details: { transferId: record?.transferId } });
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

/**
 * A pluggable rate-limit EXTENSION POINT. The default is a no-op allow (deployments inject a real
 * limiter — token bucket, Redis, etc.). Returns `{ allowed, remaining? }`.
 * @param {{ limiter?: (key: string) => ({ allowed: boolean, remaining?: number }) }} [options]
 */
export function makeRateLimitGate(options = {}) {
  const limiter = options.limiter ?? null;
  return (key) => {
    if (!limiter) return { allowed: true };
    try {
      return limiter(key);
    } catch {
      return { allowed: true }; // fail-open: rate limiting must never break the transport path
    }
  };
}

/** Shape a transport operation into an audit entry (no payload/keys). */
export function auditOperation({ operation, transferId, actingDevice, outcome, at, details }) {
  if (!operation) throw new ReliabilityValidationError("audit operation requires { operation }");
  return { operation, transferId: transferId ?? null, actingDevice: actingDevice ?? null, outcome: outcome ?? "ok", at: at ?? new Date().toISOString(), details: details ?? {} };
}
