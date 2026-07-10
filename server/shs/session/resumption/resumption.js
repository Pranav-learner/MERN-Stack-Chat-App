/**
 * @module shs/session/resumption
 *
 * Session resumption infrastructure. Lets a device resume an existing (idle/paused)
 * session WITHOUT renegotiating keys. Resumption is proven by an opaque **resume
 * token**: a payload HMAC'd with the session's device-local `resumptionKey` (derived
 * in Sprint 3's key derivation). The server never sees the resumption key — token
 * issuance + verification are device-local.
 *
 * @security Tokens carry only PUBLIC identifiers (sessionId, keyId, generation) + an
 * expiry, authenticated by an HMAC. They reveal no key material. This module does NOT
 * renegotiate or re-derive keys — resumption reuses the existing session keys.
 */

import crypto from "node:crypto";
import { ResumptionError } from "../errors.js";

/** Resume-token format version. */
export const RESUME_TOKEN_VERSION = 1;
/** Default resume-token validity window (ms). */
export const DEFAULT_RESUME_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Issue a resume token for a session, signed with its device-local resumption key.
 *
 * @param {object} params
 * @param {string} params.sessionId @param {string} params.keyId @param {number} params.generation
 * @param {Buffer} params.resumptionKey device-local key (from {@link deriveSessionKeys})
 * @param {number} [params.ttlMs] @param {() => number} [params.clock]
 * @returns {string} `v1.<payloadB64url>.<macB64url>`
 *
 * @example
 * ```js
 * const token = issueResumeToken({ sessionId, keyId, generation, resumptionKey: keys.resumptionKey });
 * ```
 */
export function issueResumeToken(params) {
  const clock = params.clock ?? (() => Date.now());
  const now = clock();
  const payload = {
    v: RESUME_TOKEN_VERSION,
    sid: params.sessionId,
    kid: params.keyId,
    gen: params.generation,
    iat: now,
    exp: now + (params.ttlMs ?? DEFAULT_RESUME_TOKEN_TTL_MS),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = sign(payloadB64, params.resumptionKey);
  return `v${RESUME_TOKEN_VERSION}.${payloadB64}.${mac}`;
}

/**
 * Verify + decode a resume token against a session's resumption key.
 * @param {string} token @param {Buffer} resumptionKey @param {{ clock?: () => number }} [options]
 * @returns {{ sessionId: string, keyId: string, generation: number, issuedAt: number, expiresAt: number }}
 * @throws {ResumptionError} on a malformed / tampered / expired token
 */
export function verifyResumeToken(token, resumptionKey, options = {}) {
  const clock = options.clock ?? (() => Date.now());
  if (typeof token !== "string") throw new ResumptionError("Resume token must be a string");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== `v${RESUME_TOKEN_VERSION}`) {
    throw new ResumptionError("Malformed resume token");
  }
  const [, payloadB64, mac] = parts;
  const expected = sign(payloadB64, resumptionKey);
  if (!constantTimeEqualHex(mac, expected)) {
    throw new ResumptionError("Resume token signature mismatch");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (error) {
    throw new ResumptionError("Corrupted resume-token payload", { cause: error });
  }
  if (clock() >= payload.exp) throw new ResumptionError("Resume token has expired");
  return { sessionId: payload.sid, keyId: payload.kid, generation: payload.gen, issuedAt: payload.iat, expiresAt: payload.exp };
}

/**
 * Build resume metadata to attach to a session on resume (audit trail; no secrets).
 * @param {{ from: string, at?: number, via?: string }} params
 */
export function resumeMetadata(params) {
  return { resumedFrom: params.from, resumedAt: new Date(params.at ?? Date.now()).toISOString(), via: params.via ?? "token" };
}

function sign(data, key) {
  return crypto.createHmac("sha256", key).update(data).digest("base64url");
}

function constantTimeEqualHex(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
