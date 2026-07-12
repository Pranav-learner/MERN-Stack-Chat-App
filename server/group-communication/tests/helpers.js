/**
 * Shared test helpers for the Group Communication (Layer 10, Sprint 2) suite. DB-free — everything runs
 * under `node --test` with an in-memory repository + a deterministic clock + id generator + injected
 * directory / presence / messaging hooks, so the tests never import mongoose.
 */

import { GroupCommunicationEngine } from "../manager/groupCommunicationEngine.js";
import { createInMemoryGroupCommRepository } from "../repository/inMemoryGroupCommRepository.js";
import { createGroupCommunicationApi } from "../api/groupCommunicationApi.js";
import { GroupCommEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export function makeIdGen(prefix = "gc") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

/** A deterministic random-bytes source (for reproducible key fingerprints). */
export function makeRandomBytes(seed = 1) {
  let s = seed >>> 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      out[i] = s & 0xff;
    }
    return out;
  };
}

/**
 * Build an engine over an in-memory repo with a controllable directory + presence. @param {object} opts
 * @param {string[]} [opts.members] active member ids @param {Set<string>} [opts.online] online device ids
 * @param {(memberId) => string[]} [opts.devicesOf] device resolver (default: one `${memberId}-d`)
 */
export function makeEngine(opts = {}) {
  const clock = opts.clock ?? makeClock();
  const repo = createInMemoryGroupCommRepository();
  const events = new GroupCommEventBus();
  const members = opts.members ?? ["alice", "bob", "carol"];
  const memberList = members.map((m) => ({ memberId: m, role: "member", state: "active" }));
  const online = opts.online ?? new Set(members.map((m) => `${m}-d`));
  const devicesOf = opts.devicesOf ?? ((m) => [`${m}-d`]);
  const sends = [];
  const directory = {
    getActiveMembers: async () => (opts.membersProvider ? opts.membersProvider() : memberList),
    getGroupVersions: async () => opts.versions ?? { membership: members.length, metadata: 1, group: 1 },
  };
  const engine = new GroupCommunicationEngine({
    ...repo,
    events,
    clock: clock.now,
    idGenerator: opts.idGen ?? makeIdGen(),
    randomBytes: makeRandomBytes(opts.seed ?? 1),
    directory,
    deviceResolver: async (m) => devicesOf(m),
    presenceResolver: async (d) => (opts.presence ? opts.presence(d) : online.has(d)),
    messagingSend: opts.messagingSend ?? (async (env) => { sends.push(env); return { message: { messageId: `l8-${sends.length}` }, delivered: opts.deliveredDefault !== false }; }),
    maxFanout: opts.maxFanout,
    keyTtlMs: opts.keyTtlMs,
  });
  const api = createGroupCommunicationApi(engine);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { engine, api, repo, events, clock, online, sends, captured, members };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

export function deviceId(member) {
  return `${member}-d`;
}
