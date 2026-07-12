/**
 * @module optimization/planners/executionTimeline
 *
 * Builds an **execution timeline** from a frozen Sprint-1 execution plan — an ordered list of steps each
 * annotated with an estimated start `offsetMs` (relative to dispatch) + estimated `durationMs`, computed
 * by honouring the plan's `dependsOn` edges (a step starts after the latest of its dependencies finishes;
 * independent steps share an offset → they can run in parallel). The base offset carries any scheduling
 * window delay. Durations are coarse, deterministic estimates (media steps cost more) — NOT measurements.
 *
 * @security Reads the plan's control-plane step shape (subsystem/action/route) only. No content.
 */

import { deepFreeze } from "../_fabric.js";

/** Coarse per-action duration estimates (ms). Deterministic; refined in a later sprint. */
const ACTION_DURATION = Object.freeze({
  deliver: 50,
  "relay-deliver": 80,
  store: 40,
  "deliver-media": 400,
  "fanout-media-ref": 120,
  "deliver-media-ref": 60,
  fanout: 150,
  sync: 100,
  "enqueue-delta": 30,
  "register-receipt": 20,
  "relay-deliver-media": 500,
});

const DEFAULT_DURATION = 50;

/**
 * Build a timeline for an execution plan.
 * @param {object} executionPlan the frozen Sprint-1 execution plan
 * @param {object} [opts] `{ baseOffsetMs }`
 * @returns {{ steps: object[], estimatedTotalMs: number, baseOffsetMs: number }}
 */
export function buildTimeline(executionPlan, opts = {}) {
  const base = Math.max(0, opts.baseOffsetMs ?? 0);
  const steps = executionPlan?.steps ?? [];
  const byId = new Map();
  const timeline = [];

  for (const step of steps) {
    const duration = ACTION_DURATION[step.action] ?? DEFAULT_DURATION;
    // start after the latest dependency finishes; no deps → base offset
    let offset = base;
    for (const dep of step.dependsOn ?? []) {
      const d = byId.get(dep);
      if (d) offset = Math.max(offset, d.offsetMs + d.durationMs);
    }
    const entry = { stepId: step.stepId, subsystem: step.subsystem, action: step.action, route: step.route, required: step.required, offsetMs: offset, durationMs: duration, parallelizable: (step.dependsOn ?? []).length === 0 };
    byId.set(step.stepId, entry);
    timeline.push(entry);
  }

  const estimatedTotalMs = timeline.reduce((max, s) => Math.max(max, s.offsetMs + s.durationMs), base);
  return deepFreeze({ steps: timeline, estimatedTotalMs, baseOffsetMs: base });
}
