/**
 * Test helpers for the Network Reliability subsystem (Layer 7, Sprint 3). Node built-ins only.
 * Imports via SPECIFIC files (not index) so mongoose is never loaded — DB-free under `node --test`.
 * Not a test file.
 */

import { NetworkReliabilityManager } from "../manager/networkReliabilityManager.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import { ReliabilityEventBus } from "../events/events.js";
import { ReliabilityMetrics } from "../observability/metrics.js";
import { ReliabilityMonitor } from "../monitoring/reliabilityMonitor.js";

export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

export function makeIdGen(prefix = "conn") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

export const noSleep = async () => {};

/**
 * Recovery hooks whose `reconnect` succeeds after `succeedAfter` attempts (0 = always succeed, -1 =
 * never). Records what ran.
 */
export function makeHooks(options = {}) {
  const ran = [];
  let reconnectAttempts = 0;
  const succeedAfter = options.succeedAfter ?? 1; // succeed on the 1st reconnect
  return {
    ran,
    reconnectAttempts: () => reconnectAttempts,
    hooks: {
      resume: async () => { ran.push("resume"); return options.resume ?? false; },
      reconnect: async () => { ran.push("reconnect"); reconnectAttempts++; return succeedAfter >= 0 && reconnectAttempts >= succeedAfter; },
      refreshCandidates: async () => { ran.push("refreshCandidates"); return true; },
      switchRelay: async () => { ran.push("switchRelay"); return true; },
      gracefulFail: async () => { ran.push("gracefulFail"); return true; },
    },
  };
}

/** Build a fully-wired in-memory NetworkReliabilityManager (no real timers). */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const idGenerator = options.idGenerator ?? makeIdGen();
  const repo = createInMemoryReliabilityRepository();
  const events = new ReliabilityEventBus();
  const metrics = new ReliabilityMetrics({ clock: () => clock() });
  const monitor = new ReliabilityMonitor({ events, metrics, clock, idGenerator: makeIdGen("alert"), sink: repo.alerts, ...(options.monitor ?? {}) });
  const h = options.hooks ?? makeHooks(options.hookOptions);
  const manager = new NetworkReliabilityManager({
    ...repo,
    events,
    metrics,
    monitor,
    recoveryHooks: h.hooks,
    clock,
    idGenerator,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 15_000,
    retryPolicy: options.retryPolicy ?? { maxAttempts: 5, baseDelayMs: 5, jitter: false },
    sleep: noSleep,
  });
  return { manager, repo, events, metrics, monitor, clock, idGenerator, hooks: h };
}

export function recordEvents(events) {
  const log = [];
  events.on("*", (e) => log.push(e));
  log.types = () => log.map((e) => e.type);
  log.ofType = (type) => log.filter((e) => e.type === type);
  return log;
}
