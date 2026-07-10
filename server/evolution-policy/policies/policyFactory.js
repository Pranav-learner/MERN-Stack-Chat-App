/**
 * @module evolution-policy/policies
 *
 * Reusable evolution-policy factories. The shared policy kinds are REUSED verbatim from
 * the Sprint 1 {@link module:session-evolution/policies} module (no redesign); this sprint
 * adds the **session-age** policy and re-exports everything behind one import so the rekey
 * engine has a single policy surface.
 *
 * A policy is a serializable descriptor `{ id, type, params, description, enabled }` that
 * describes WHEN a session should evolve — it never performs the rekey itself.
 *
 * @security Policies are pure decision descriptors. They carry no key material. The
 * `custom` policy keeps an in-memory `evaluate` predicate that is never serialized.
 */

import crypto from "node:crypto";
import {
  createTimeBasedPolicy,
  createMessageCountPolicy,
  createManualPolicy,
  createSecurityEventPolicy,
  createDeviceEventPolicy,
  createAdministratorPolicy,
  createCustomPolicy,
  isPolicyDescriptor,
  serializePolicy,
} from "../../session-evolution/policies/policies.js";
import { PolicyType } from "../types/types.js";
import { RekeyValidationError } from "../errors.js";

/**
 * Evolve once a session reaches a maximum age (measured from session creation, regardless
 * of activity or rekeys). NEW in Sprint 3.
 * @param {{ maxAgeMs: number, id?: string, description?: string, enabled?: boolean }} params
 * @returns {import("../../session-evolution/types/types.js").PolicyDescriptor}
 * @example const p = createSessionAgePolicy({ maxAgeMs: 12 * 60 * 60 * 1000 }); // rekey after 12h of session life
 */
export function createSessionAgePolicy({ maxAgeMs, id, description, enabled = true } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new RekeyValidationError("session-age policy requires a positive maxAgeMs", { details: { maxAgeMs } });
  }
  return {
    id: id ?? crypto.randomUUID(),
    type: PolicyType.SESSION_AGE,
    params: { maxAgeMs },
    description: description ?? `Rekey once the session is older than ${maxAgeMs}ms`,
    enabled,
  };
}

export {
  createTimeBasedPolicy,
  createMessageCountPolicy,
  createManualPolicy,
  createSecurityEventPolicy,
  createDeviceEventPolicy,
  createAdministratorPolicy,
  createCustomPolicy,
  isPolicyDescriptor,
  serializePolicy,
  PolicyType,
};
