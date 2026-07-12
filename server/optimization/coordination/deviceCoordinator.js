/**
 * @module optimization/coordination/deviceCoordinator
 *
 * The **Cross-Device Coordinator** (STEP 6) — decides, for a user with multiple devices, WHICH device
 * plays WHICH role in a communication: it selects a deterministic PRIMARY (the device that performs the
 * send), designates REPLICAS (devices that receive a synchronized copy), and produces a coordination plan
 * across the delivery / synchronization / media / execution facets. Primary selection is deterministic
 * (highest score, then most-recently-seen, then lowest id) so every device computes the same coordinator
 * independently — no elected-leader round trip.
 *
 * @security Reasons over device ids + scores + last-seen timestamps only. No content. Devices are supplied
 * (injected provider or per-request) — the coordinator never queries a device service directly.
 * @evolution Collaborative multi-device execution (several devices cooperating on one send) is a future
 * extension: the plan already models per-facet device assignment, so it generalises without a redesign.
 */

import { DeviceRole, CoordinationKind, OptimizationEventType } from "../types/types.js";

export class CrossDeviceCoordinator {
  /**
   * @param {object} [deps]
   * @param {(userId: string) => object[]} [deps.deviceProvider] service-agnostic device resolver
   * @param {import("../events/events.js").OptimizationEventBus} [deps.events]
   */
  constructor(deps = {}) {
    this.deviceProvider = deps.deviceProvider ?? null;
    this.events = deps.events ?? null;
  }

  /**
   * Coordinate a communication across a user's devices.
   * @param {object} params `{ userId, devices?, analysis, requestId }`
   * @returns {object} coordination plan
   */
  coordinate(params = {}) {
    let devices = params.devices ?? [];
    if ((!devices || devices.length === 0) && this.deviceProvider && params.userId) {
      try {
        devices = (this.deviceProvider(params.userId) ?? []).map((d) => (typeof d === "string" ? { deviceId: d } : d));
      } catch {
        devices = [];
      }
    }

    // Single-device (or unknown): the sender's own device is primary; no replicas.
    if (!devices || devices.length === 0) {
      const plan = this._plan(null, [], params.analysis);
      const result = { requestId: params.requestId ?? null, userId: params.userId ?? null, primary: null, replicas: [], secondary: [], deviceCount: 0, singleDevice: true, plan };
      this.events?.emit(OptimizationEventType.DEVICES_COORDINATED, { requestId: params.requestId, deviceCount: 0, primary: null });
      return result;
    }

    const ranked = [...devices].sort(deviceComparator);
    const primary = ranked[0];
    const replicas = ranked.slice(1);

    const annotated = ranked.map((d, i) => ({ deviceId: d.deviceId, role: i === 0 ? DeviceRole.PRIMARY : DeviceRole.REPLICA, score: d.score ?? null }));
    const plan = this._plan(primary.deviceId, replicas.map((d) => d.deviceId), params.analysis);
    const result = { requestId: params.requestId ?? null, userId: params.userId ?? null, primary: primary.deviceId, replicas: replicas.map((d) => d.deviceId), secondary: [], devices: annotated, deviceCount: ranked.length, singleDevice: ranked.length === 1, plan };

    this.events?.emit(OptimizationEventType.DEVICES_COORDINATED, { requestId: params.requestId, deviceCount: ranked.length, primary: primary.deviceId });
    return result;
  }

  /** Build the per-facet coordination plan (delivery/sync/media/execution → device assignment). */
  _plan(primary, replicas, analysis) {
    return {
      [CoordinationKind.DELIVERY]: { device: primary, note: "primary delivers" },
      [CoordinationKind.SYNCHRONIZATION]: { devices: primary ? [primary, ...replicas] : replicas, note: "replicate to all devices" },
      [CoordinationKind.MEDIA]: { device: primary, note: analysis?.isMedia ? "primary handles media" : "n/a" },
      [CoordinationKind.EXECUTION]: { device: primary, note: "primary executes" },
    };
  }
}

/** Deterministic device ordering: highest score, then most-recently-seen, then lowest id. */
function deviceComparator(a, b) {
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (sb !== sa) return sb - sa;
  const la = a.lastSeenMs ?? 0;
  const lb = b.lastSeenMs ?? 0;
  if (lb !== la) return lb - la;
  return String(a.deviceId) < String(b.deviceId) ? -1 : 1;
}
