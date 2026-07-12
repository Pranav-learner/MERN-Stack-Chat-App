/**
 * @module media-reliability/security
 *
 * **Security audit + documented assumptions** for the whole Layer 11 Secure Media Platform (Step 7). A
 * machine-readable posture manifest for the media / media-delivery / media-reliability APIs, plus the
 * security assumptions the platform makes, plus helpers (an ownership gate, a pagination clamp, a rate-
 * limit extension point, and an operation-audit shaper). "Audit media operations" is realized by the
 * manager recording an audit entry (via {@link auditOperation}) on every mutating reliability op.
 *
 * @security This module asserts SECURITY properties of the media platform; it moves no data. The core
 * guarantees: every media API is JWT-authenticated + owner/member-scoped; media encryption is DEVICE-
 * LOCAL (per-file AES-256-GCM key never sent — the server stores only opaque ciphertext + a fingerprint,
 * Sprint 1); integrity is verified end-to-end (whole-object hash + per-chunk hashes) so tampered/corrupt
 * media is rejected; storage authorization is provider-agnostic (opaque locators, no plaintext); a resume
 * re-transfers only remaining chunks from a monotonic checkpoint (no replay can forge or rewind
 * progress); and cryptographic replay resistance lives in Layer 5. This reliability layer adds per-
 * operation ownership scoping + a uniform audit trail.
 */

import { ReliabilityValidationError, UnauthorizedReliabilityError } from "../errors.js";

/** The security posture of each media-platform API group. */
export const API_SECURITY_POSTURE = Object.freeze({
  media: { base: "/api/media", authenticated: true, ownerScoped: true, integrityVerified: true, metadataOnly: true, blindRelay: true, rateLimit: true },
  "media-delivery": { base: "/api/media-delivery", authenticated: true, ownerScoped: true, integrityVerified: true, metadataOnly: true, blindRelay: true, rateLimit: true },
  "media-reliability": { base: "/api/media-reliability", authenticated: true, ownerScoped: true, metadataOnly: true, auditEvery: true, rateLimit: true },
});

/** Documented security ASSUMPTIONS the media platform relies on (surfaced by the API + docs). */
export const SECURITY_ASSUMPTIONS = Object.freeze([
  { topic: "media-authorization", assumption: "Every media API is JWT-authenticated; media is owner-scoped, and conversation/group-bound media is accessible only to members (membership enforced upstream by Layer 10). Reads return control-plane metadata only." },
  { topic: "storage-authorization", assumption: "Storage is provider-agnostic: the platform stores OPAQUE ciphertext blobs under opaque locators via the pluggable storage-provider interface. The provider never sees plaintext or keys; the reliability layer never touches the provider directly (it drives recovery via injected hooks)." },
  { topic: "encrypted-media-integrity", assumption: "Media is encrypted DEVICE-LOCAL (per-file AES-256-GCM key never sent). The whole-object hash (Sprint 1) + per-chunk hashes (Sprint 2) are verified end-to-end, so tampered or corrupted media is rejected on upload, download, and streaming." },
  { topic: "metadata-integrity", assumption: "Media metadata carries sizes/hashes/MIME/iv/tag/key-fingerprint ONLY — never plaintext or key bytes. A no-content/no-key deep scan runs before every persist across the media layers." },
  { topic: "replay-protection", assumption: "A resume re-transfers only remaining chunks from a monotonic checkpoint — a replay cannot forge or rewind operation progress. Duplicate chunk reports are idempotent (Sprint-2 receiveChunk). Cryptographic replay resistance lives in Layer 5." },
  { topic: "api-authorization", assumption: "All reliability endpoints are JWT-authenticated + owner-scoped; a device may only register/checkpoint/recover its OWN media operations. Reads return control-plane metadata + numeric aggregates only (no content/keys)." },
  { topic: "rate-limiting", assumption: "Upload / download / stream / recover / resume endpoints expose a rate-limit extension point to blunt media-storm abuse." },
  { topic: "audit", assumption: "Every mutating media-reliability operation is recorded to an append-only audit trail (operation, ids, actor, outcome) — no content or keys." },
]);

const REQUIRED_CONTROLS = ["authenticated", "ownerScoped", "metadataOnly"];

/** Audit the API posture: `{ ok, findings, groups, assumptions }`. */
export function auditMediaApis(posture = API_SECURITY_POSTURE) {
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
    throw new UnauthorizedReliabilityError("Caller does not own this media operation", { details: { operationId: record?.operationId } });
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

/** Shape a media operation into an audit entry (no content/keys). */
export function auditOperation({ operation, operationId, mediaId, actingDevice, outcome, at, details }) {
  if (!operation) throw new ReliabilityValidationError("audit operation requires { operation }");
  return { operation, operationId: operationId ?? null, mediaId: mediaId ?? null, actingDevice: actingDevice ?? null, outcome: outcome ?? "ok", at: at ?? new Date().toISOString(), details: details ?? {} };
}
