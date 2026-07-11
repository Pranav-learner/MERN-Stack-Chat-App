/**
 * @module pdp/negotiation
 *
 * PDP-level **capability negotiation orchestration**. The workflow's capabilities stage needs to
 * negotiate the requester's device against EACH reachable candidate device and partition the
 * results into compatible / incompatible / unavailable. This module wraps the Sprint 3
 * {@link module:capabilities/manager Capability Manager} to do exactly that — it adds no new
 * negotiation logic, it just fans the single-pair negotiation out over the candidate set.
 *
 * @security Operates on PUBLIC capability negotiation results only — versions, transports, flags.
 * No key material.
 */

import { CapabilityError } from "../../capabilities/errors.js";
import { PdpFailureReason } from "../types/types.js";

/**
 * Negotiate the requester's device against each candidate device.
 *
 * @param {object} params
 * @param {object} params.capabilities a CapabilityManager (or anything with `negotiate`)
 * @param {string} params.requester @param {string} params.requesterDevice @param {string} params.targetUser
 * @param {string[]} params.candidateDeviceIds
 * @param {string|object} [params.transportPolicy] the capability transport-preference policy
 * @returns {Promise<{ compatible: Array<{deviceId:string,result:object}>, incompatible: Array<{deviceId:string,reason:string,result:object}>, unavailable: Array<{deviceId:string,reason:string}> }>}
 */
export async function negotiateCandidates(params) {
  const { capabilities, requester, requesterDevice, targetUser, candidateDeviceIds, transportPolicy } = params;

  const settled = await Promise.all(
    (candidateDeviceIds ?? []).map(async (deviceId) => {
      try {
        const { result } = await capabilities.negotiate({
          requester,
          requesterDevice,
          targetUser,
          targetDevice: deviceId,
          policy: transportPolicy,
        });
        return { deviceId, result };
      } catch (error) {
        // A device with no registered / expired capabilities is UNAVAILABLE for negotiation (not a
        // fatal error for the whole workflow — other devices may still be compatible).
        const reason = error instanceof CapabilityError ? mapCapabilityError(error) : PdpFailureReason.INTERNAL_ERROR;
        return { deviceId, error: reason };
      }
    }),
  );

  const compatible = [];
  const incompatible = [];
  const unavailable = [];
  for (const entry of settled) {
    if (entry.error) unavailable.push({ deviceId: entry.deviceId, reason: entry.error });
    else if (entry.result?.compatible) compatible.push({ deviceId: entry.deviceId, result: entry.result });
    else incompatible.push({ deviceId: entry.deviceId, reason: entry.result?.failureReason ?? PdpFailureReason.CAPABILITY_CONFLICT, result: entry.result });
  }
  // Deterministic ordering (by deviceId) so downstream selection is reproducible.
  const byId = (a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
  compatible.sort(byId);
  incompatible.sort(byId);
  unavailable.sort(byId);
  return { compatible, incompatible, unavailable };
}

/** Map a capability error code to a PDP failure reason. */
function mapCapabilityError(error) {
  switch (error.code) {
    case "ERR_CAPABILITY_NOT_FOUND":
      return PdpFailureReason.CAPABILITY_CONFLICT;
    case "ERR_CAPABILITY_EXPIRED":
      return PdpFailureReason.CAPABILITY_CONFLICT;
    default:
      return PdpFailureReason.CAPABILITY_CONFLICT;
  }
}
