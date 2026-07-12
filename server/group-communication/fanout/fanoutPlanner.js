/**
 * @module group-communication/fanout
 *
 * The **Fan-out Engine (planner)** — turns "send this message to the group" into a concrete DELIVERY
 * PLAN: one leg per target DEVICE (a user may have several), classified online vs. offline, prioritized,
 * and annotated with retry metadata. It is PURE PLANNING — it produces the plan; the engine dispatches
 * each online leg through the INJECTED Layer 8 reliable-messaging `send` hook (it does NOT reimplement
 * transport) and defers offline legs to the pending queue for later resume.
 *
 * Multi-device: every active member contributes one leg per registered device. The sender's OWN device
 * is skipped (it already has the plaintext). Delivery is at-most-once per device (see the
 * {@link module:group-communication/delivery DeliveryGuard}).
 *
 * @security The plan carries ids + presence + priority + a message REFERENCE (no ciphertext, no keys).
 * The ciphertext travels only on the Layer 8 leg the engine dispatches.
 *
 * @performance For a 1000+-member group the plan is a flat leg array built in one linear pass; legs are
 * priority-sorted once. A `maxFanout` cap guards against unbounded plans (partial fan-out beyond it).
 */

import crypto from "node:crypto";
import {
  GroupDeliveryState,
  FanoutStatus,
  DeliveryPriority,
  PRIORITY_WEIGHT,
  DEFAULT_MAX_FANOUT,
  DEFAULT_MAX_DEVICES_PER_MEMBER,
  GROUP_COMM_SCHEMA_VERSION,
} from "../types/types.js";
import { InvalidFanoutPlanError } from "../errors.js";
import { createLeg, summarizeLegs } from "../delivery/delivery.js";

/**
 * Generate a fan-out delivery plan. Pure. @param {object} params
 * @param {object} params.message a group message ref `{ messageId, groupId, keyVersion, senderId, priority? }`
 * @param {Array<{ memberId, role?, state?, devices: Array<{deviceId, online}> }>} params.recipients
 * @param {string} [params.senderDeviceId] the sender's own device (skipped)
 * @param {number} [params.maxFanout] cap on legs (partial beyond it)
 * @param {number} [params.maxDevicesPerMember]
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {object} the plan
 */
export function generateFanoutPlan(params) {
  const { message } = params;
  if (!message || !message.messageId || !message.groupId) throw new InvalidFanoutPlanError("A message reference (messageId + groupId) is required");
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const maxFanout = params.maxFanout ?? DEFAULT_MAX_FANOUT;
  const maxDevices = params.maxDevicesPerMember ?? DEFAULT_MAX_DEVICES_PER_MEMBER;
  const priority = message.priority ?? DeliveryPriority.NORMAL;
  const nowIso = new Date(clock()).toISOString();

  const legs = [];
  let truncated = false;
  for (const recipient of params.recipients ?? []) {
    const devices = (recipient.devices ?? []).slice(0, maxDevices);
    for (const device of devices) {
      if (params.senderDeviceId && String(device.deviceId) === String(params.senderDeviceId)) continue; // skip own device
      if (legs.length >= maxFanout) {
        truncated = true;
        break;
      }
      legs.push(createLeg({ memberId: recipient.memberId, deviceId: device.deviceId, online: !!device.online, priority }));
    }
    if (truncated) break;
  }

  // Priority-sort (higher first), online before offline within a priority (deliver reachable first).
  legs.sort((a, b) => (PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]) || (Number(b.online) - Number(a.online)));

  const summary = summarizeLegs(legs);
  const onlineCount = legs.filter((l) => l.online).length;
  return {
    planId: idGenerator(),
    groupId: String(message.groupId),
    messageId: String(message.messageId),
    keyVersion: message.keyVersion,
    senderId: message.senderId ?? null,
    status: legs.length === 0 ? FanoutStatus.COMPLETED : FanoutStatus.PLANNING,
    priority,
    legs,
    summary,
    onlineCount,
    offlineCount: legs.length - onlineCount,
    truncated,
    createdAt: nowIso,
    updatedAt: nowIso,
    schemaVersion: GROUP_COMM_SCHEMA_VERSION,
  };
}

/**
 * Recompute a plan's status from its legs. `completed` = every non-skipped leg is delivered OR queued
 * for a genuinely offline target (offline legs are deferred, not failures); `partial` = some delivered +
 * some still queued/failed; `failed` = nothing delivered and some failed.
 */
export function recomputeFanoutStatus(plan) {
  const summary = summarizeLegs(plan.legs);
  const pending = summary.dispatched + summary.queued;
  const anyDelivered = summary.delivered > 0;
  let status;
  if (summary.total === summary.skipped) status = FanoutStatus.COMPLETED;
  else if (pending === 0 && summary.failed === 0) status = FanoutStatus.COMPLETED;
  else if (pending === 0 && summary.failed > 0 && !anyDelivered) status = FanoutStatus.FAILED;
  else if (summary.queued > 0 || summary.failed > 0) status = anyDelivered || summary.dispatched > 0 ? FanoutStatus.PARTIAL : FanoutStatus.IN_PROGRESS;
  else status = FanoutStatus.IN_PROGRESS;
  return { ...plan, status, summary };
}

/** The offline (queued) legs of a plan — the deferred-delivery set. */
export function offlineLegs(plan) {
  return (plan.legs ?? []).filter((l) => l.state === GroupDeliveryState.QUEUED);
}

/** Validate a fan-out plan's shape. @throws {InvalidFanoutPlanError} */
export function validateFanoutPlan(plan) {
  if (!plan || typeof plan !== "object") throw new InvalidFanoutPlanError("plan must be an object");
  if (!plan.planId || !plan.groupId || !plan.messageId) throw new InvalidFanoutPlanError("plan is missing planId/groupId/messageId");
  if (!Array.isArray(plan.legs)) throw new InvalidFanoutPlanError("plan.legs must be an array");
  const seen = new Set();
  for (const leg of plan.legs) {
    if (!leg.deviceId) throw new InvalidFanoutPlanError("every leg needs a deviceId");
    if (seen.has(leg.deviceId)) throw new InvalidFanoutPlanError(`duplicate device in plan: ${leg.deviceId}`, { details: { deviceId: leg.deviceId } });
    seen.add(leg.deviceId);
  }
  return plan;
}
