/**
 * @module device-trust/lifecycle
 *
 * Pure helpers that translate a lifecycle {@link DeviceAction} into the target
 * trust status, the event type to emit, and the record patch to persist. Keeping
 * this pure makes the state machine easy to test and reuse; the
 * {@link DeviceManager} applies the patches and emits the events.
 */

import { DeviceAction, DeviceEventType, TrustStatus } from "../types.js";
import { assertTransition } from "../policies/trustPolicy.js";
import { DeviceValidationError } from "../errors.js";

/** Map a lifecycle action to its target trust status + event type. */
const ACTION_TARGET = Object.freeze({
  [DeviceAction.ACTIVATE]: { status: TrustStatus.TRUSTED, event: DeviceEventType.ACTIVATED },
  [DeviceAction.DEACTIVATE]: { status: TrustStatus.INACTIVE, event: DeviceEventType.DEACTIVATED },
  [DeviceAction.REVOKE]: { status: TrustStatus.REVOKED, event: DeviceEventType.REVOKED },
  [DeviceAction.BLOCK]: { status: TrustStatus.BLOCKED, event: DeviceEventType.BLOCKED },
  [DeviceAction.UNBLOCK]: { status: TrustStatus.TRUSTED, event: DeviceEventType.UNBLOCKED },
  [DeviceAction.EXPIRE]: { status: TrustStatus.EXPIRED, event: DeviceEventType.UPDATED },
});

/**
 * Compute the persistence patch + event for applying `action` to `device`.
 *
 * @param {{ trustStatus: string }} device the current device record
 * @param {string} action a {@link DeviceAction}
 * @param {{ now?: number, reason?: string }} [options]
 * @returns {{ patch: object, event: string, targetStatus: string }}
 * @throws {DeviceValidationError} unknown action
 * @throws {InvalidTrustTransitionError} illegal transition
 */
export function planTransition(device, action, options = {}) {
  const target = ACTION_TARGET[action];
  if (!target) throw new DeviceValidationError(`Unknown device action: ${action}`);
  assertTransition(device.trustStatus, target.status);

  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const patch = { trustStatus: target.status, updatedAt: nowIso };

  // Keep the Sprint 1 legacy `status` field loosely in sync.
  patch.status =
    target.status === TrustStatus.REVOKED || target.status === TrustStatus.BLOCKED
      ? "revoked"
      : "active";

  if (action === DeviceAction.REVOKE) {
    patch.revokedAt = nowIso;
    if (options.reason) patch.revokedReason = options.reason;
  }
  if (action === DeviceAction.DEACTIVATE) {
    patch.deactivatedAt = nowIso;
  }
  if (action === DeviceAction.ACTIVATE || action === DeviceAction.UNBLOCK) {
    patch.lastActive = nowIso;
  }

  return { patch, event: target.event, targetStatus: target.status };
}
