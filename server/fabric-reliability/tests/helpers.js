/**
 * Shared test helpers for the Production Communication Fabric reliability suite (Layer 12, Sprint 4).
 * DB-free — everything runs under `node --test` with the in-memory repository, a deterministic clock, and
 * an injected no-op retry sleep (so backoff never adds real delay). A capturing event log makes the whole
 * reliability pipeline inspectable.
 */

import { FabricReliabilityManager } from "../manager/reliabilityManager.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import { createReliabilityApi } from "../api/reliabilityApi.js";
import { FabricReliabilityEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/** Build a reliability manager + api over an in-memory repo with a captured event log + no-op retry sleep. */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryReliabilityRepository();
  const events = new FabricReliabilityEventBus();
  const manager = new FabricReliabilityManager({
    ...repo,
    events,
    clock: clock.now,
    sleep: async () => {}, // deterministic: no real backoff delay
    config: options.config,
    security: options.security,
    logger: options.logger,
    tracer: options.tracer,
  });
  const api = createReliabilityApi(manager);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, api, repo, events, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** An executor that fails `failFor` attempts then succeeds (for retry/recovery tests). */
export function flakyExecutor(failFor, error) {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls <= failFor) throw error ?? Object.assign(new Error("transient glitch"), { code: "ERR_TRANSIENT", failureClass: "transient" });
    return { ok: true, calls };
  };
  fn.calls = () => calls;
  return fn;
}

/** A typed error with an explicit failure class. */
export function classedError(failureClass, code = "ERR_TEST") {
  return Object.assign(new Error(`${failureClass} error`), { code, failureClass });
}
