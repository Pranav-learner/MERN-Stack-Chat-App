/**
 * @module group-communication/key-management/rekey
 *
 * **Membership rekeying policy** — pure decision logic that maps a membership change to a key-rotation
 * decision, keeping the engine's rekey behaviour declarative + testable. It answers three questions for
 * a given trigger:
 *
 *  1. **Should we rotate?** (join / leave / remove / ownership-transfer / scheduled / manual / compromise)
 *  2. **Fresh or ratchet?** — a departure (`leave`/`remove`/`transfer`/`compromise`) MUST use FRESH
 *     randomness so the departed member cannot derive the next epoch; benign rotations may ratchet.
 *  3. **Recovery metadata** — what a member needs to catch up (the new version + who must redistribute).
 *
 * @security This module reasons over trigger names + member ids ONLY. Actual key derivation is
 * device-local (see {@link module:group-communication/key-management/groupKey}); this module never
 * touches secret bytes.
 *
 * @evolution "Minimize disruption to active conversations": a rotation SUPERSEDES (not deletes) the old
 * key, so messages already encrypted under it stay decryptable while new messages use the new epoch.
 */

import { RekeyTrigger, FRESH_SECRET_TRIGGERS, ALL_REKEY_TRIGGERS } from "../types/types.js";
import { GroupCommValidationError } from "../errors.js";

/** Map a Sprint-1 group membership event type to a rekey trigger (or null = no rekey). */
export const MEMBERSHIP_EVENT_TO_TRIGGER = Object.freeze({
  "group.member_joined": RekeyTrigger.MEMBER_JOIN,
  "group.member_left": RekeyTrigger.MEMBER_LEAVE,
  "group.member_removed": RekeyTrigger.MEMBER_REMOVE,
  "group.member_banned": RekeyTrigger.MEMBER_REMOVE,
  "group.ownership_transferred": RekeyTrigger.OWNERSHIP_TRANSFER,
});

/** Validate a rekey trigger. @throws {GroupCommValidationError} */
export function validateTrigger(trigger) {
  if (!ALL_REKEY_TRIGGERS.includes(trigger)) throw new GroupCommValidationError(`Unknown rekey trigger "${trigger}"`, { details: { trigger } });
  return trigger;
}

/** Whether a trigger requires FRESH randomness (a departure) vs. may ratchet. */
export function requiresFreshSecret(trigger) {
  return FRESH_SECRET_TRIGGERS.includes(trigger);
}

/**
 * Decide how to rekey for a trigger. Pure. @param {object} params
 * @param {string} params.trigger @param {string[]} [params.members] the member set AFTER the change
 * @param {string} [params.affectedMember] the member who joined/left/was removed
 * @param {number} [params.currentVersion] the current active key version
 * @returns {{ rotate: boolean, fresh: boolean, trigger: string, targetVersion: number, recovery: object }}
 */
export function planRekey(params) {
  validateTrigger(params.trigger);
  const rotate = true; // every recognized trigger rotates in this engine (safety-first)
  const fresh = requiresFreshSecret(params.trigger);
  const targetVersion = (params.currentVersion ?? 0) + 1;
  const members = [...new Set((params.members ?? []).map(String))];
  return {
    rotate,
    fresh,
    trigger: params.trigger,
    targetVersion,
    recovery: {
      // Who must obtain the new epoch key (everyone still in the group).
      redistributeTo: members,
      // The departed member (excluded from redistribution), if any.
      excluded: params.affectedMember && fresh ? String(params.affectedMember) : null,
      reason: params.trigger,
    },
  };
}

/**
 * Build recovery metadata a reconnecting member uses to catch up on missed rekeys: the key versions it
 * is missing between its last-known version and the current version. Pure.
 * @param {number} lastKnownVersion @param {number} currentVersion
 * @returns {{ missedVersions: number[], from: number, to: number }}
 */
export function rekeyCatchUp(lastKnownVersion, currentVersion) {
  const from = Math.max(0, Number(lastKnownVersion) || 0);
  const to = Number(currentVersion) || 0;
  const missedVersions = [];
  for (let v = from + 1; v <= to; v++) missedVersions.push(v);
  return { missedVersions, from, to };
}

export { RekeyTrigger, MEMBERSHIP_EVENT_TO_TRIGGER as EVENT_TRIGGERS };
