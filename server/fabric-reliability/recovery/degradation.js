/**
 * @module fabric-reliability/recovery/degradation
 *
 * **Graceful degradation + fallback strategies** (STEP 5) — when an operation cannot be recovered, degrade
 * cleanly instead of hard-failing: return a safe, minimal fallback the caller can act on, and record that
 * the platform is operating in a degraded mode for that operation kind. Fallback strategies are pluggable
 * per {@link FabricOperationKind}; the default is a "degraded, no-result" marker that never breaches
 * consistency (it does NOT fabricate a successful outcome — it signals the caller to retry later / queue).
 *
 * @security Reasons over kinds + classifications only. No content.
 */

import { FabricOperationKind, ReliabilityEventType } from "../types/types.js";

/** Default fallback: signal a clean degraded failure (caller should defer / surface to the user). */
const defaultFallback = (kind, error) => ({ degraded: true, kind, fallback: null, note: `degraded: ${kind} unavailable`, retryable: true, cause: error?.code ?? null });

/** Per-kind fallback overrides — the seams a deployment plugs richer degradation into. */
const DEFAULT_FALLBACKS = Object.freeze({
  // a routing failure degrades to "no adaptive route" — the Fabric's deterministic default still applies
  [FabricOperationKind.ROUTE_EVALUATE]: (kind) => ({ degraded: true, kind, fallback: { adaptive: false }, note: "routing degraded → deterministic default", retryable: true }),
  // a capability failure degrades to the permissive baseline (already the Sprint-2 fallback)
  [FabricOperationKind.CAPABILITY_COLLECT]: (kind) => ({ degraded: true, kind, fallback: { baseline: true }, note: "capability degraded → baseline", retryable: true }),
  // a scheduling failure degrades to immediate execution (do not drop the communication)
  [FabricOperationKind.SCHEDULE]: (kind) => ({ degraded: true, kind, fallback: { mode: "immediate" }, note: "scheduling degraded → immediate", retryable: false }),
});

export class GracefulDegradation {
  /** @param {object} [opts] `{ fallbacks, events }` */
  constructor(opts = {}) {
    this.fallbacks = { ...DEFAULT_FALLBACKS, ...(opts.fallbacks ?? {}) };
    this.events = opts.events ?? null;
    this._degraded = new Map(); // kind → count (for health)
  }

  /** Register / override a fallback strategy for a kind. */
  register(kind, fallbackFn) {
    this.fallbacks[kind] = fallbackFn;
    return this;
  }

  /**
   * Degrade an operation that could not be recovered.
   * @param {string} kind @param {Error} error @param {object} [ctx] `{ operationId }`
   * @returns {object} the degraded descriptor
   */
  degrade(kind, error, ctx = {}) {
    const fn = this.fallbacks[kind] ?? defaultFallback;
    const descriptor = fn(kind, error);
    this._degraded.set(kind, (this._degraded.get(kind) ?? 0) + 1);
    this.events?.emit(ReliabilityEventType.GRACEFUL_DEGRADATION, { operationId: ctx.operationId, kind, retryable: descriptor.retryable });
    return descriptor;
  }

  /** A snapshot of degradation counts per kind (feeds health). */
  snapshot() {
    return Object.fromEntries(this._degraded);
  }
}
