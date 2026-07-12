/**
 * @module optimization/dto
 *
 * DTO normalization for the **Resource Optimization** subsystem. Normalizes the optimizer's input — a
 * communication request (delegated to the frozen Sprint-1 normalizer) plus optional optimization HINTS
 * (QoS override, scheduling mode, execution window, device set, resource-cost override, policy overrides)
 * — into stable, control-plane-only shapes. Deep validation is the validators' job; content is never
 * accepted.
 *
 * @security Hints are declarations (class/mode/window/device ids/budget units). No bytes.
 */

import { normalizeCommunicationRequest } from "../_fabric.js";

const asString = (v) => (v == null ? undefined : String(v));
const asNumber = (v) => (Number.isFinite(v) ? v : v == null ? undefined : Number(v) || 0);

/** Normalize a device descriptor for cross-device coordination. */
export function normalizeDevice(d) {
  if (d == null) return null;
  if (typeof d === "string") return { deviceId: d, score: null, lastSeenMs: null };
  return { deviceId: asString(d.deviceId), score: asNumber(d.score) ?? null, lastSeenMs: asNumber(d.lastSeenMs) ?? null, capabilities: Array.isArray(d.capabilities) ? d.capabilities.map(String) : [] };
}

/** Normalize an execution window `{ notBefore, notAfter }` (ms epoch or offset). */
export function normalizeWindow(w) {
  if (w == null || typeof w !== "object") return null;
  return { notBefore: asNumber(w.notBefore) ?? null, notAfter: asNumber(w.notAfter) ?? null };
}

/** Normalize a resource-cost override (partial). */
export function normalizeCostOverride(c) {
  if (c == null || typeof c !== "object") return null;
  const out = {};
  for (const k of ["bandwidth", "cpu", "memory", "storage", "connection", "transfer", "execution"]) if (c[k] != null) out[k] = asNumber(c[k]);
  return Object.keys(out).length ? out : null;
}

/**
 * Normalize the full optimization input.
 * @param {object} input `{ ...communicationRequest, qosClass?, mode?, window?, devices?, cost?, policyOverrides? }`
 * @returns {object}
 */
export function normalizeOptimizationInput(input = {}) {
  const request = normalizeCommunicationRequest(input);
  return {
    request,
    qosClass: asString(input.qosClass),
    mode: asString(input.mode),
    window: normalizeWindow(input.window),
    devices: Array.isArray(input.devices) ? input.devices.map(normalizeDevice).filter((d) => d && d.deviceId) : [],
    costOverride: normalizeCostOverride(input.cost),
    policyOverrides: input.policyOverrides && typeof input.policyOverrides === "object" ? { ...input.policyOverrides } : {},
  };
}

/** Normalize pagination for list endpoints. */
export function normalizePagination({ limit, offset } = {}) {
  const lim = limit == null ? undefined : Math.max(1, Math.min(1000, Number(limit) || 0));
  const off = offset == null ? 0 : Math.max(0, Number(offset) || 0);
  return { limit: lim, offset: off };
}
