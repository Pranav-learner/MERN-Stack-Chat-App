/**
 * Shared test helpers for the Intelligent Routing (Layer 12, Sprint 2) suite. DB-free — everything runs
 * under `node --test` with the in-memory repository + a deterministic clock, so the tests never import
 * mongoose. A capturing event log makes the whole adaptive pipeline inspectable.
 */

import { AdaptiveRoutingEngine } from "../manager/adaptiveRoutingEngine.js";
import { createInMemoryAdaptiveRepository } from "../repository/inMemoryAdaptiveRepository.js";
import { createAdaptiveRoutingApi } from "../api/adaptiveRoutingApi.js";
import { AdaptiveEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/** Build an engine + api over an in-memory repo with a captured event log. */
export function makeEngine(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryAdaptiveRepository();
  const events = new AdaptiveEventBus();
  const engine = new AdaptiveRoutingEngine({
    ...repo,
    events,
    clock: clock.now,
    config: options.config,
    providers: options.providers,
    resolvers: options.resolvers,
    scorers: options.scorers,
    policyHooks: options.policyHooks,
  });
  const api = createAdaptiveRoutingApi(engine);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { engine, api, repo, events, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** Request builders. */
export const directRequest = (o = {}) => ({ type: "direct-message", senderId: "alice", recipients: ["bob"], ...o });
export const groupRequest = (o = {}) => ({ type: "group-message", senderId: "alice", groupId: "g1", ...o });
export const mediaRequest = (o = {}) => ({ type: "media-transfer", senderId: "alice", recipients: ["bob"], mediaType: "image", payloadRef: { id: "m1", size: 2048, hash: "h" }, ...o });
export const syncRequest = (o = {}) => ({ type: "synchronization", senderId: "alice", conversationId: "c1", ...o });
