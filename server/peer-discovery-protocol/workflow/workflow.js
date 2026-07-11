/**
 * @module pdp/workflow
 *
 * The **deterministic discovery workflow** — the ordered pipeline that fuses the three subsystems:
 *
 * ```
 * identity → devices → presence → capabilities → selection   (→ plan, assembled by the manager)
 *  └Discovery┘         └Presence┘  └Capabilities┘  └Selectors┘
 * ```
 *
 * Each stage either advances the workflow or throws a {@link WorkflowStageError} carrying the stage
 * + a machine-readable {@link module:pdp/types.PdpFailureReason}, so the manager can record exactly
 * where + why a run failed (and decide whether to recover). The engine performs the READS + pure
 * transforms; the manager owns state persistence, events, and the final PLAN assembly (which is
 * the only stage that writes).
 *
 * @security The workflow composes PUBLIC data from Discovery / Presence / Capabilities only. No key
 * material, no transport establishment.
 */

import { WorkflowStage, PdpFailureReason } from "../types/types.js";
import { WorkflowStageError } from "../errors.js";
import { negotiateCandidates } from "../negotiation/negotiation.js";
import { selectDevices } from "../selectors/selection.js";

const fail = (stage, reason, message, details) => {
  throw new WorkflowStageError(message, { stage, reason, details });
};

/**
 * Run the discovery workflow up to (not including) plan assembly. Returns the resolved inputs a
 * connection plan is built from; throws {@link WorkflowStageError} on any stage failure.
 *
 * @param {object} ctx
 * @param {string} ctx.requester @param {string} ctx.requesterDevice @param {string} ctx.targetUser
 * @param {string[]} [ctx.targetDevices] requested subset (empty = all)
 * @param {string} [ctx.selectionPolicy] @param {object} [ctx.selectionOptions]
 * @param {string|object} [ctx.transportPolicy] @param {number} [ctx.maxDevices]
 * @param {() => number} [ctx.clock]
 * @param {object} deps `{ discovery, presence, capabilities }` — the three subsystem managers
 * @param {(stage: string, status: string, meta?: object) => (void|Promise<void>)} [hook] progress hook
 * @returns {Promise<{ identity: object|null, presenceSnapshot: object[], selectedDevices: object[], negotiation: object, discoveredCount: number, candidateCount: number }>}
 */
export async function runDiscoveryWorkflow(ctx, deps, hook = () => {}) {
  const { discovery, presence, capabilities } = deps;
  const now = (ctx.clock ?? (() => Date.now()))();
  const targetDevices = (ctx.targetDevices ?? []).map(String);

  // ── stage: identity ──────────────────────────────────────────────────────
  await hook(WorkflowStage.IDENTITY, "started");
  let lookup;
  try {
    lookup = await discovery.lookupUser({ requester: ctx.requester, targetUser: ctx.targetUser, requesterDevice: ctx.requesterDevice });
  } catch (error) {
    fail(WorkflowStage.IDENTITY, PdpFailureReason.UNKNOWN_USER, `Identity resolution failed for "${ctx.targetUser}"`, { cause: error?.message });
  }
  const metadata = lookup?.metadata ?? null;
  if (!metadata || lookup?.session?.state === "failed") {
    fail(WorkflowStage.IDENTITY, PdpFailureReason.UNKNOWN_USER, `No discoverable identity for user "${ctx.targetUser}"`);
  }
  const identity = metadata.publicIdentity ?? null;
  await hook(WorkflowStage.IDENTITY, "completed", { identityId: identity?.identityId ?? null });

  // ── stage: devices (Discovery) ─────────────────────────────────────────────
  await hook(WorkflowStage.DEVICES, "started");
  let discovered = metadata.devices ?? [];
  if (targetDevices.length > 0) discovered = discovered.filter((d) => targetDevices.includes(d.deviceId));
  if (discovered.length === 0) {
    fail(WorkflowStage.DEVICES, PdpFailureReason.NO_DISCOVERABLE_DEVICES, `User "${ctx.targetUser}" has no discoverable devices`);
  }
  await hook(WorkflowStage.DEVICES, "completed", { count: discovered.length });

  // ── stage: presence ────────────────────────────────────────────────────────
  await hook(WorkflowStage.PRESENCE, "started");
  const { devices: reachableAds } = await presence.resolveActiveDevices(ctx.targetUser);
  const adByDevice = new Map((reachableAds ?? []).map((a) => [a.deviceId, a]));
  // Candidates = discoverable AND reachable (a device reachable-but-not-discoverable is a presence
  // conflict — silently excluded — and one discoverable-but-not-reachable is simply offline).
  const candidates = discovered.filter((d) => adByDevice.has(d.deviceId));
  if (candidates.length === 0) {
    fail(WorkflowStage.PRESENCE, PdpFailureReason.NO_ACTIVE_DEVICES, `No devices of user "${ctx.targetUser}" are currently reachable`);
  }
  // Enrich each candidate with full presence detail (status + lastSeen).
  const presenceDetail = new Map();
  await Promise.all(
    candidates.map(async (d) => {
      try {
        const p = await presence.getDevicePresence(ctx.targetUser, d.deviceId);
        presenceDetail.set(d.deviceId, { status: p.status, lastSeen: p.lastSeen });
      } catch {
        const ad = adByDevice.get(d.deviceId);
        presenceDetail.set(d.deviceId, { status: ad?.status ?? "online", lastSeen: null });
      }
    }),
  );
  const presenceSnapshot = candidates.map((d) => ({ deviceId: d.deviceId, status: presenceDetail.get(d.deviceId).status, lastSeen: presenceDetail.get(d.deviceId).lastSeen }));
  await hook(WorkflowStage.PRESENCE, "completed", { count: candidates.length });

  // ── stage: capabilities ────────────────────────────────────────────────────
  await hook(WorkflowStage.CAPABILITIES, "started");
  const negotiation = await negotiateCandidates({
    capabilities,
    requester: ctx.requester,
    requesterDevice: ctx.requesterDevice,
    targetUser: ctx.targetUser,
    candidateDeviceIds: candidates.map((d) => d.deviceId),
    transportPolicy: ctx.transportPolicy,
  });
  if (negotiation.compatible.length === 0) {
    fail(WorkflowStage.CAPABILITIES, PdpFailureReason.CAPABILITY_CONFLICT, `No reachable device of user "${ctx.targetUser}" is capability-compatible`, {
      incompatible: negotiation.incompatible.length,
      unavailable: negotiation.unavailable.length,
    });
  }
  await hook(WorkflowStage.CAPABILITIES, "completed", { count: negotiation.compatible.length });

  // ── stage: selection ───────────────────────────────────────────────────────
  await hook(WorkflowStage.SELECTION, "started");
  const resultByDevice = new Map(negotiation.compatible.map((c) => [c.deviceId, c.result]));
  const candidateObjs = candidates
    .filter((d) => resultByDevice.has(d.deviceId))
    .map((d) => {
      const ad = adByDevice.get(d.deviceId);
      const detail = presenceDetail.get(d.deviceId);
      return {
        deviceId: d.deviceId,
        identityId: d.identityId ?? ad?.identityId ?? null,
        publicIdentity: ad?.publicIdentity ?? (d.publicKey ? { publicKey: d.publicKey, fingerprint: d.fingerprint, algorithm: d.algorithm } : null),
        presenceStatus: detail.status,
        lastSeen: detail.lastSeen,
        platform: ad?.platform ?? d.platform,
        softwareVersion: ad?.softwareVersion,
        capabilities: resultByDevice.get(d.deviceId),
        priority: d.metadata?.priority ?? 0,
      };
    });
  const selectedDevices = selectDevices(candidateObjs, {
    policy: ctx.selectionPolicy,
    options: ctx.selectionOptions,
    maxDevices: ctx.maxDevices,
    now,
  });
  if (selectedDevices.length === 0) {
    fail(WorkflowStage.SELECTION, PdpFailureReason.INVALID_SELECTION, "Device selection produced no device");
  }
  await hook(WorkflowStage.SELECTION, "completed", { count: selectedDevices.length, primary: selectedDevices[0].deviceId });

  return {
    identity,
    presenceSnapshot,
    selectedDevices,
    negotiation,
    discoveredCount: discovered.length,
    candidateCount: candidates.length,
  };
}
