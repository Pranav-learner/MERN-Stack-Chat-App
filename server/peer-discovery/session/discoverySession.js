/**
 * @module peer-discovery/session
 *
 * The **Discovery Session** model — the record factory + pure helpers for a single
 * lookup. Every lookup creates a discovery session that binds a requester (+ requester
 * device) to a target user (+ optional target devices), carries a lifecycle state, an
 * expiration, a resolved-metadata slot, a capabilities snapshot, audit, and history.
 *
 * @security A discovery session is a PUBLIC control-plane record. Its `result` holds
 * resolved {@link module:peer-discovery/metadata DiscoveryMetadata} (public identity +
 * device descriptors) — never private keys, session keys, message keys, chain keys, or
 * shared secrets. No transport negotiation happens here (that is a future sprint).
 */

import crypto from "node:crypto";
import {
  DiscoveryState,
  LookupType,
  DISCOVERY_SCHEMA_VERSION,
  DEFAULT_SESSION_TTL_MS,
  isTerminalDiscoveryState,
} from "../types/types.js";
import { createCapabilitiesSnapshot } from "../metadata/metadata.js";

/**
 * Build a discovery session in the {@link DiscoveryState.CREATED} state.
 *
 * @param {object} params
 * @param {string} params.requester the requesting user id
 * @param {string} params.targetUser the user being discovered
 * @param {string} [params.requesterDevice] the requesting device id
 * @param {string[]} [params.targetDevices] specific device ids to resolve (empty = all)
 * @param {string} [params.lookupType] one of {@link LookupType} (inferred if omitted)
 * @param {number} [params.ttlMs] session lifetime in ms
 * @param {object} [params.metadata] free-form metadata
 * @param {string} [params.discoveryId] override id (else generated)
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").DiscoverySession}
 */
export function createDiscoverySession(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const targetDevices = (params.targetDevices ?? []).map(String);
  const lookupType = params.lookupType ?? inferLookupType(targetDevices);

  return {
    discoveryId: params.discoveryId ?? idGenerator(),
    requester: String(params.requester),
    requesterDevice: params.requesterDevice ? String(params.requesterDevice) : undefined,
    targetUser: String(params.targetUser),
    targetDevices,
    lookupType,
    state: DiscoveryState.CREATED,
    requestTime: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    resolvedAt: null,
    completedAt: null,
    result: null,
    capabilitiesSnapshot: createCapabilitiesSnapshot(),
    failureReason: null,
    audit: [],
    metadata: params.metadata ?? {},
    history: [{ from: null, to: DiscoveryState.CREATED, at: nowIso }],
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
  };
}

/** Infer the lookup type from the requested target devices. */
export function inferLookupType(targetDevices) {
  const list = targetDevices ?? [];
  if (list.length === 1) return LookupType.DEVICE;
  if (list.length > 1) return LookupType.DEVICES;
  return LookupType.USER;
}

/**
 * Whether a discovery session has passed its expiration instant.
 * @param {import("../types/types.js").DiscoverySession} session
 * @param {number} [now] epoch ms (defaults to `Date.now()`)
 * @returns {boolean}
 */
export function isDiscoverySessionExpired(session, now = Date.now()) {
  if (!session?.expiresAt) return false;
  return new Date(session.expiresAt).getTime() <= now;
}

/** Whether a discovery session is in a terminal state. @returns {boolean} */
export function isDiscoverySessionTerminal(session) {
  return isTerminalDiscoveryState(session?.state);
}

/**
 * A stable dedupe key for an in-flight lookup: same requester, target, and device set →
 * same key. Lets the manager coalesce concurrent identical lookups.
 * @param {{ requester: string, targetUser: string, lookupType?: string, targetDevices?: string[] }} params
 * @returns {string}
 */
export function discoveryDedupeKey(params) {
  const devices = [...(params.targetDevices ?? [])].map(String).sort().join(",");
  return `${params.requester}|${params.targetUser}|${params.lookupType ?? inferLookupType(params.targetDevices)}|${devices}`;
}
