/**
 * @module shs/hardening/session-guard/sessionGuard
 *
 * Continuous session validation. Before a Secure Session (Sprint 3) is used, the
 * SessionGuard re-checks — every time — that it is still safe:
 *
 *   - **Ownership** — the caller is a participant.
 *   - **Participant identity** — participants still resolve in the identity directory.
 *   - **Device identity** — the bound devices are still known/usable.
 *   - **Metadata** — the session record is well-formed (not corrupted).
 *   - **Expiration** — the session is not expired.
 *   - **Protocol compatibility** — the session's version is still supported.
 *   - **Trust state** — the participants' verification/trust has not been revoked or
 *     flagged changed (via an optional Layer 3 trust lookup).
 *
 * Lookups are injected (Layer 3 identity/device/trust) and OPTIONAL — an absent lookup
 * skips that check, so the guard is usable standalone and in tests.
 *
 * @security Reads PUBLIC state only. It never touches keys. It is the gate Layer 5
 * calls before encrypting with a session's keys.
 */

import { isSupported } from "../../protocol/version.js";
import { isExpired } from "../../session/expiration/expiration.js";
import { validateMetadata } from "../../session/validators/validators.js";
import { HardeningEventType } from "../types.js";
import { SessionGuardError } from "../errors.js";

/** Trust states that make a session unsafe to use. */
const UNSAFE_TRUST_STATES = new Set(["changed", "compromised", "revoked", "blocked"]);
/** Device trust states that make a session unsafe. */
const UNSAFE_DEVICE_STATES = new Set(["revoked", "blocked"]);

export class SessionGuard {
  /**
   * @param {object} [deps]
   * @param {(userId: string) => Promise<object|null>} [deps.identityLookup]
   * @param {(userId: string, deviceId: string) => Promise<object|null>} [deps.deviceLookup]
   * @param {(verifier: string, subject: string) => Promise<{ state?: string }|null>} [deps.trustLookup]
   * @param {() => number} [deps.clock] @param {{ emit: Function }} [deps.events]
   */
  constructor(deps = {}) {
    this.identityLookup = deps.identityLookup ?? null;
    this.deviceLookup = deps.deviceLookup ?? null;
    this.trustLookup = deps.trustLookup ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.events = deps.events ?? null;
  }

  /**
   * Validate a session for use by a caller. Returns a detailed verdict; never throws
   * for a "not ok" result (use {@link assert} to throw).
   *
   * @param {object} session a Secure Session record/DTO
   * @param {{ actingUser?: string }} [context]
   * @returns {Promise<{ ok: boolean, checks: Record<string, boolean>, reasons: string[] }>}
   */
  async validate(session, context = {}) {
    const checks = {};
    const reasons = [];
    const fail = (name, reason) => {
      checks[name] = false;
      reasons.push(reason);
    };
    const pass = (name) => {
      checks[name] = true;
    };

    // Metadata
    try {
      validateMetadata(session);
      pass("metadata");
    } catch (error) {
      fail("metadata", `corrupted-metadata:${error.code ?? "unknown"}`);
      // If metadata is corrupt, the rest is unreliable — short-circuit.
      this._emitFail(session, reasons);
      return { ok: false, checks, reasons };
    }

    // Ownership
    if (context.actingUser !== undefined) {
      if ((session.participants ?? []).map(String).includes(String(context.actingUser))) pass("ownership");
      else fail("ownership", "not-a-participant");
    }

    // Expiration
    if (!isExpired(session, this.clock())) pass("expiration");
    else fail("expiration", "expired");

    // Protocol compatibility
    if (!session.protocolVersion || isSupported(session.protocolVersion)) pass("protocol");
    else fail("protocol", `unsupported-version:${session.protocolVersion}`);

    // Participant identity
    if (this.identityLookup) {
      let allKnown = true;
      for (const user of session.participants ?? []) {
        if (!(await this.identityLookup(user))) {
          allKnown = false;
          reasons.push(`unknown-identity:${user}`);
        }
      }
      checks.participantIdentity = allKnown;
    }

    // Device identity
    if (this.deviceLookup && session.deviceIds) {
      let devicesOk = true;
      for (const [role, deviceId] of Object.entries(session.deviceIds)) {
        if (!deviceId) continue;
        const userId = role === "initiator" ? session.participants?.[0] : session.participants?.[1];
        const device = await this.deviceLookup(userId, deviceId);
        if (!device || UNSAFE_DEVICE_STATES.has(device.trustStatus)) {
          devicesOk = false;
          reasons.push(`device-unusable:${deviceId}`);
        }
      }
      checks.deviceIdentity = devicesOk;
    }

    // Trust state (between the two participants, both directions)
    if (this.trustLookup && (session.participants ?? []).length === 2) {
      const [a, b] = session.participants;
      const t1 = await this.trustLookup(a, b);
      const t2 = await this.trustLookup(b, a);
      const unsafe = [t1, t2].some((t) => t && UNSAFE_TRUST_STATES.has(t.state));
      checks.trust = !unsafe;
      if (unsafe) reasons.push("trust-unsafe");
    }

    const ok = Object.values(checks).every(Boolean);
    if (!ok) this._emitFail(session, reasons);
    return { ok, checks, reasons };
  }

  /**
   * Validate + throw {@link SessionGuardError} if the session is not usable.
   * @param {object} session @param {{ actingUser?: string }} [context]
   * @returns {Promise<{ ok: true, checks: object }>}
   * @throws {SessionGuardError}
   */
  async assert(session, context = {}) {
    const verdict = await this.validate(session, context);
    if (!verdict.ok) {
      throw new SessionGuardError(`Session rejected: ${verdict.reasons.join(", ")}`, {
        details: { sessionId: session.sessionId, checks: verdict.checks, reasons: verdict.reasons },
      });
    }
    return verdict;
  }

  /** @private */
  _emitFail(session, reasons) {
    if (this.events) {
      this.events.emit(HardeningEventType.SESSION_GUARD_FAILED, { sessionId: session.sessionId, details: { reasons } });
    }
  }
}
