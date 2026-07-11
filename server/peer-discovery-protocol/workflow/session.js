/**
 * @module pdp/workflow/session
 *
 * The **PDP Session** model — the record factory + pure helpers for a single discovery-protocol
 * run. Every `startDiscovery` creates a session that binds a requester (+ requester device) to a
 * target user, tracks the workflow state + the stage reached, references the produced connection
 * plan, and records stage history + audit.
 *
 * @security A PDP session is a PUBLIC control-plane record. It references a connection plan by id;
 * it holds no key material and negotiates no transport (that is Layer 7).
 */

import crypto from "node:crypto";
import {
  PdpState,
  PDP_SCHEMA_VERSION,
  DEFAULT_PDP_SESSION_TTL_MS,
  SelectionPolicy,
  isTerminalPdpState,
} from "../types/types.js";

/**
 * Build a PDP session in the {@link PdpState.CREATED} state.
 *
 * @param {object} params
 * @param {string} params.requester @param {string} params.requesterDevice @param {string} params.targetUser
 * @param {string[]} [params.targetDevices] requested device subset (empty = all)
 * @param {string} [params.selectionPolicy] one of {@link SelectionPolicy}
 * @param {number} [params.ttlMs] @param {object} [params.metadata]
 * @param {string} [params.discoveryId] @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").PdpSession}
 */
export function createPdpSession(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_PDP_SESSION_TTL_MS;

  return {
    discoveryId: params.discoveryId ?? idGenerator(),
    requester: String(params.requester),
    requesterDevice: String(params.requesterDevice),
    targetUser: String(params.targetUser),
    targetDevices: (params.targetDevices ?? []).map(String),
    selectionPolicy: params.selectionPolicy ?? SelectionPolicy.CAPABILITY_SCORE,
    state: PdpState.CREATED,
    stage: null,
    planId: null,
    failureReason: null,
    attempts: 0,
    requestTime: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    completedAt: null,
    stageHistory: [],
    audit: [],
    history: [{ from: null, to: PdpState.CREATED, at: nowIso }],
    metadata: params.metadata ?? {},
    schemaVersion: PDP_SCHEMA_VERSION,
  };
}

/** Whether a PDP session has passed its expiration instant. @returns {boolean} */
export function isPdpSessionExpired(session, now = Date.now()) {
  if (!session?.expiresAt) return false;
  return new Date(session.expiresAt).getTime() <= now;
}

/** Whether a PDP session is in a terminal state. @returns {boolean} */
export function isPdpSessionTerminal(session) {
  return isTerminalPdpState(session?.state);
}

/**
 * A dedupe key for identical concurrent discovery runs: same requester+device, target, device
 * subset, and policy → same key.
 * @param {{ requester: string, requesterDevice: string, targetUser: string, targetDevices?: string[], selectionPolicy?: string }} params
 * @returns {string}
 */
export function pdpDedupeKey(params) {
  const devices = [...(params.targetDevices ?? [])].map(String).sort().join(",");
  return `${params.requester}:${params.requesterDevice}|${params.targetUser}|${params.selectionPolicy ?? SelectionPolicy.CAPABILITY_SCORE}|${devices}`;
}

/** Build a stage-history entry. */
export function stageEntry(stage, status, meta = {}) {
  const entry = { stage, status, at: meta.at ?? new Date().toISOString() };
  if (meta.reason !== undefined) entry.reason = meta.reason;
  if (meta.count !== undefined) entry.count = meta.count;
  if (meta.details !== undefined) entry.details = meta.details;
  return entry;
}

/** Append an audit entry immutably (capped). */
export function appendAudit(audit, entry, max = 100) {
  const next = [...(audit ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
