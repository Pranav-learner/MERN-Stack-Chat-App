/**
 * Shared test helpers for the Group Foundation (Layer 10, Sprint 1) suite. DB-free — everything runs
 * under `node --test` with an in-memory repository + a deterministic clock + id generator, so the tests
 * never import mongoose.
 */

import { GroupManager } from "../manager/groupManager.js";
import { createInMemoryGroupRepository } from "../repository/inMemoryGroupRepository.js";
import { createGroupApi } from "../api/groupApi.js";
import { GroupEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export function makeIdGen(prefix = "g") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** Build a manager + api over an in-memory repo with a captured event log. */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryGroupRepository();
  const events = new GroupEventBus();
  const manager = new GroupManager({
    ...repo,
    events,
    clock: clock.now,
    idGenerator: options.idGen ?? makeIdGen(),
    maxMembers: options.maxMembers,
    defaultVisibility: options.defaultVisibility,
  });
  const api = createGroupApi(manager);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, api, repo, events, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** Create a group owned by `owner` with a couple of active members, returning ids. */
export async function seedGroup(api, { owner = "alice", name = "Group", members = [] } = {}) {
  const group = await api.createGroup({ ownerId: owner, metadata: { name }, initialMembers: members.map((memberId) => ({ memberId })) });
  return group;
}
