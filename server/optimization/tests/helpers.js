/**
 * Shared test helpers for the Resource Optimization (Layer 12, Sprint 3) suite. DB-free — everything runs
 * under `node --test` with the in-memory repository + a deterministic clock, so the tests never import
 * mongoose. A capturing event log makes the whole optimization pipeline inspectable.
 */

import { GlobalOptimizer } from "../manager/globalOptimizer.js";
import { createInMemoryOptimizationRepository } from "../repository/inMemoryOptimizationRepository.js";
import { createOptimizationApi } from "../api/optimizationApi.js";
import { OptimizationEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/** Build an optimizer + api over an in-memory repo with a captured event log. */
export function makeOptimizer(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryOptimizationRepository();
  const events = new OptimizationEventBus();
  const optimizer = new GlobalOptimizer({
    ...repo,
    events,
    clock: clock.now,
    config: options.config,
    providers: options.providers,
    resolvers: options.resolvers,
    resourcePolicies: options.resourcePolicies,
    schedulingPolicies: options.schedulingPolicies,
  });
  const api = createOptimizationApi(optimizer);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { optimizer, api, repo, events, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** Request builders. */
export const directRequest = (o = {}) => ({ type: "direct-message", senderId: "alice", recipients: ["bob"], ...o });
export const groupRequest = (o = {}) => ({ type: "group-message", senderId: "alice", groupId: "g1", ...o });
export const mediaRequest = (o = {}) => ({ type: "media-transfer", senderId: "alice", recipients: ["bob"], mediaType: "video", payloadRef: { id: "m1", size: 50 * 1024 * 1024, hash: "h" }, ...o });
export const syncRequest = (o = {}) => ({ type: "synchronization", senderId: "alice", conversationId: "c1", ...o });
export const urgentRequest = (o = {}) => ({ type: "control", senderId: "alice", recipients: ["bob"], priority: "urgent", ...o });
