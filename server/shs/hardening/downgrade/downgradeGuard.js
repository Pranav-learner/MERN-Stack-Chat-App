/**
 * @module shs/hardening/downgrade/downgradeGuard
 *
 * Downgrade-attack protection. A network attacker who can tamper with the cleartext
 * negotiation could strip capabilities or force a lower protocol/algorithm version so
 * both peers settle on a weaker configuration. This guard detects that.
 *
 * ## Strategy — transcript binding + max-common validation
 * 1. **Reject-below-minimum / insecure versions** outright.
 * 2. **Max-common validation** — the negotiated version MUST equal the highest version
 *    both parties actually support. Anything lower ⇒ a downgrade.
 * 3. **Capability/algorithm-strip detection** — every capability/algorithm supported
 *    by BOTH parties must appear in the negotiated set; a missing one ⇒ stripped.
 * 4. **Transcript hash** — a stable hash over both parties' full advertised offers.
 *    Both sides can compare transcripts out-of-band (or a future signed handshake can
 *    bind it); a mismatch ⇒ the offers were tampered with.
 *
 * @security Operates on PUBLIC offers/results only. It does not itself authenticate
 * the transcript (no signatures in Sprint 1–3); it makes tampering DETECTABLE and
 * exposes the transcript hash for a future authenticated binding.
 */

import crypto from "node:crypto";
import { DowngradeReason } from "../types.js";
import { DowngradeAttackError } from "../errors.js";
import { MINIMUM_VERSION, SUPPORTED_VERSIONS, compare, isSupported } from "../../protocol/version.js";

/**
 * Versions explicitly considered insecure (denylist). Empty today; the guard rejects
 * anything here regardless of the min-version rule. Bump as versions are deprecated.
 * @type {ReadonlySet<string>}
 */
export const INSECURE_VERSIONS = new Set([]);

/**
 * @typedef {object} DowngradeGuardOptions
 * @property {string} [minimumVersion=MINIMUM_VERSION]
 * @property {string[]} [supportedVersions=SUPPORTED_VERSIONS] versions THIS build supports
 * @property {Set<string>} [insecureVersions=INSECURE_VERSIONS]
 * @property {{ emit: Function }} [events]
 */

/** Compute the highest version common to two supported-version lists (or null). */
export function maxCommonVersion(aVersions, bVersions) {
  const b = new Set(bVersions);
  let best = null;
  for (const v of aVersions) {
    if (b.has(v) && (best === null || compare(v, best) > 0)) best = v;
  }
  return best;
}

/** A stable transcript hash binding both parties' advertised offers. */
export function transcriptHash(initiatorOffer, responderOffer) {
  const canon = (o) =>
    JSON.stringify({
      versions: [...(o.supportedVersions ?? (o.version ? [o.version] : []))].sort(),
      capabilities: [...(o.capabilities ?? [])].sort(),
      algorithms: [...(o.algorithms ?? [])].map((a) => String(a).toLowerCase()).sort(),
    });
  return crypto.createHash("sha256").update("SHS-downgrade-transcript-v1").update(canon(initiatorOffer)).update("|").update(canon(responderOffer)).digest("hex");
}

/**
 * Validate a completed negotiation against downgrade attacks.
 *
 * @param {object} params
 * @param {object} params.initiatorOffer `{ supportedVersions?, version?, capabilities?, algorithms? }`
 * @param {object} params.responderOffer same shape
 * @param {object} params.negotiated `{ version?, capabilities?, algorithm? }` (SHS and/or KA result)
 * @param {DowngradeGuardOptions} [options]
 * @returns {import("../types.js").DowngradeVerdict}
 */
export function checkDowngrade(params, options = {}) {
  const minimum = options.minimumVersion ?? MINIMUM_VERSION;
  const supported = options.supportedVersions ?? SUPPORTED_VERSIONS;
  const insecure = options.insecureVersions ?? INSECURE_VERSIONS;
  const { initiatorOffer, responderOffer, negotiated } = params;

  const negVersion = negotiated.version;
  if (negVersion !== undefined) {
    if (insecure.has(negVersion)) return reject(DowngradeReason.INSECURE_VERSION, { negotiatedVersion: negVersion }, options);
    if (compare(negVersion, minimum) < 0) return reject(DowngradeReason.BELOW_MINIMUM_VERSION, { negotiatedVersion: negVersion, minimum }, options);

    // Max-common validation: the negotiated version must be the highest both support.
    const initVersions = initiatorOffer.supportedVersions ?? (initiatorOffer.version ? [initiatorOffer.version] : supported);
    const respVersions = responderOffer.supportedVersions ?? (responderOffer.version ? [responderOffer.version] : supported);
    const expected = maxCommonVersion(initVersions, respVersions);
    if (expected && compare(negVersion, expected) < 0) {
      return reject(DowngradeReason.NOT_MAX_COMMON_VERSION, { expectedVersion: expected, negotiatedVersion: negVersion }, options);
    }
  }

  // Capability-strip detection: mutually-supported capabilities must survive.
  if (negotiated.capabilities !== undefined) {
    const mutual = intersect(initiatorOffer.capabilities, responderOffer.capabilities);
    const negSet = new Set(negotiated.capabilities);
    const stripped = mutual.filter((c) => !negSet.has(c));
    if (stripped.length > 0) {
      return reject(DowngradeReason.CAPABILITY_STRIPPED, { strippedCapabilities: stripped }, options);
    }
  }

  // Algorithm-strip detection: the agreed algorithm must be the most-preferred mutual.
  if (negotiated.algorithm !== undefined && initiatorOffer.algorithms && responderOffer.algorithms) {
    const respSet = new Set(responderOffer.algorithms.map((a) => String(a).toLowerCase()));
    const preferred = initiatorOffer.algorithms.map((a) => String(a).toLowerCase()).find((a) => respSet.has(a));
    if (preferred && String(negotiated.algorithm).toLowerCase() !== preferred) {
      return reject(DowngradeReason.ALGORITHM_STRIPPED, { expected: preferred, negotiated: negotiated.algorithm }, options);
    }
  }

  return { ok: true, transcript: transcriptHash(initiatorOffer, responderOffer) };
}

/**
 * Assert no downgrade; throws {@link DowngradeAttackError} on rejection.
 * @param {object} params @param {DowngradeGuardOptions} [options]
 * @returns {import("../types.js").DowngradeVerdict}
 */
export function assertNoDowngrade(params, options = {}) {
  const verdict = checkDowngrade(params, options);
  if (!verdict.ok) {
    throw new DowngradeAttackError(`Downgrade blocked: ${verdict.reason}`, { details: verdict });
  }
  return verdict;
}

/**
 * Compare two transcript hashes (constant-time). A mismatch ⇒ tampered offers.
 * @throws {DowngradeAttackError}
 */
export function assertTranscriptMatch(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    throw new DowngradeAttackError("Downgrade blocked: transcript mismatch", { details: { reason: DowngradeReason.TRANSCRIPT_MISMATCH } });
  }
  return true;
}

function intersect(a, b) {
  const set = new Set(b ?? []);
  return [...new Set(a ?? [])].filter((x) => set.has(x));
}

function reject(reason, extra, options) {
  if (options.events) options.events.emit("hardening.downgrade_blocked", { reason, details: extra });
  return { ok: false, reason, ...extra };
}

export { isSupported };
