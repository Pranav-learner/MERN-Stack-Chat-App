/**
 * Shared test helpers for the Communication Fabric (Layer 12, Sprint 1) suite. DB-free — everything runs
 * under `node --test` with the in-memory repository + a deterministic clock, so the tests never import
 * mongoose. A capturing event log + recording subsystem adapters make the whole pipeline inspectable.
 */

import { CommunicationFabricManager } from "../manager/communicationFabricManager.js";
import { createInMemoryFabricRepository } from "../repository/inMemoryFabricRepository.js";
import { createFabricApi } from "../api/fabricApi.js";
import { FabricEventBus } from "../events/events.js";
import { createRecordingAdapter } from "../registry/subsystemAdapter.js";
import { ALL_SUBSYSTEM_KINDS, SubsystemKind } from "../types/types.js";

/** A deterministic, advanceable clock. */
export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/**
 * Build a manager + api over an in-memory repo with a captured event log and recording adapters for a set
 * of subsystem kinds.
 * @param {object} [options]
 * @param {string[]} [options.subsystems] kinds to register recording adapters for (default: all real ones)
 * @param {string[]} [options.failActions] adapter actions that should fail (fallback tests)
 * @param {object} [options.resolvers] context resolvers
 * @param {object} [options.policyConfig] policy config bag
 */
export function makeFabric(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryFabricRepository();
  const events = new FabricEventBus();
  const manager = new CommunicationFabricManager({
    ...repo,
    events,
    clock: clock.now,
    resolvers: options.resolvers,
    policyConfig: options.policyConfig,
    config: options.config,
    decisionRules: options.decisionRules,
  });

  // register recording adapters so executions actually run + are inspectable
  const kinds = options.subsystems ?? ALL_SUBSYSTEM_KINDS.filter((k) => k !== SubsystemKind.VOICE && k !== SubsystemKind.VIDEO);
  const adapters = {};
  for (const kind of kinds) {
    const adapter = createRecordingAdapter({ kind, failOn: options.failActions, failRoutes: options.failRoutes, alwaysFail: options.failKinds?.includes(kind) });
    adapters[kind] = adapter;
    manager.registerSubsystem(adapter);
  }

  const api = createFabricApi(manager);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, api, repo, events, adapters, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** A minimal valid direct-message request. */
export function directRequest(overrides = {}) {
  return { type: "direct-message", senderId: "alice", recipients: ["bob"], ...overrides };
}

/** A group-message request. */
export function groupRequest(overrides = {}) {
  return { type: "group-message", senderId: "alice", groupId: "g1", ...overrides };
}

/** A media-transfer request. */
export function mediaRequest(overrides = {}) {
  return { type: "media-transfer", senderId: "alice", recipients: ["bob"], mediaType: "image", payloadRef: { id: "m1", size: 1024, hash: "abc" }, ...overrides };
}

/** A synchronization request. */
export function syncRequest(overrides = {}) {
  return { type: "synchronization", senderId: "alice", conversationId: "c1", ...overrides };
}
