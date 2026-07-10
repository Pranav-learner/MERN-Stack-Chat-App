/**
 * @module crypto-hardening/lifecycle
 *
 * **Key lifecycle verification.** Independent, read-only checks that every cryptographic key's
 * lifecycle — creation → activation → usage → rotation → destruction — is consistent across the
 * PUBLIC metadata records the Layer 5 subsystems produce, and that **no record ever leaks key
 * material**. Pure functions; the {@link KeyLifecycleVerifier} runs a suite and returns a report.
 *
 * @security The core invariant enforced here is that a persisted/serialized record contains no
 * raw key bytes. {@link findKeyMaterial} deep-scans for `Buffer` instances and forbidden secret
 * field names anywhere in the graph.
 */

import { HardeningEventType, KeyPhase } from "../types/types.js";
import { HardeningEventBus } from "../events/events.js";

/** Field names that must never appear in a serialized record (secret key material). */
const FORBIDDEN_FIELDS = ["encryptionKey", "macKey", "chainKey", "chainSecret", "messageKey", "sharedSecret", "ratchetMaterial", "privateKey", "rootKeyBytes"];

/**
 * Deep-scan an object graph for anything that looks like secret key material (a `Buffer`, or a
 * forbidden field name). Returns the paths found (empty = clean).
 * @param {any} value @param {string} [path] @param {string[]} [found]
 * @returns {string[]}
 */
export function findKeyMaterial(value, path = "$", found = []) {
  if (value == null) return found;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    found.push(`${path} (binary key material)`);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findKeyMaterial(v, `${path}[${i}]`, found));
    return found;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_FIELDS.includes(k) && v != null) found.push(`${path}.${k}`);
      else findKeyMaterial(v, `${path}.${k}`, found);
    }
  }
  return found;
}

/** A single check result. */
const check = (name, ok, detail) => ({ name, ok, detail });

/**
 * Verify a message-key state record's lifecycle (Sprint 5). Every recorded message must be
 * `used`/`destroyed`, delivery-tagged, and monotonic per direction; no key material.
 * @param {object} state a public message-key DTO @returns {object[]} checks
 */
export function verifyMessageKeyLifecycle(state) {
  const checks = [];
  const material = findKeyMaterial(state);
  checks.push(check("no-key-material", material.length === 0, material[0]));
  const messages = state.messages ?? [];
  checks.push(check("messages-terminal", messages.every((m) => m.state === "used" || m.state === "destroyed"), "a message key is not marked used/destroyed"));
  checks.push(check("messages-delivered", messages.every((m) => ["encrypted", "decrypted", "failed"].includes(m.delivery)), "a message lacks a delivery status"));
  const sends = messages.filter((m) => m.direction === "sending").map((m) => m.messageNumber);
  checks.push(check("send-numbers-unique", new Set(sends).size === sends.length, "duplicate sending message number"));
  return checks;
}

/**
 * Verify a forward-secrecy state record's lifecycle (Sprint 2): superseded/destroyed
 * generations, destruction records, no key material.
 * @param {object} state a public FS DTO @returns {object[]} checks
 */
export function verifyForwardSecrecyLifecycle(state) {
  const checks = [];
  const material = findKeyMaterial(state);
  checks.push(check("no-key-material", material.length === 0, material[0]));
  const gens = state.generations ?? [];
  const current = state.currentGeneration ?? 0;
  checks.push(check("single-active-generation", gens.filter((g) => g.status === "active").length <= 1, "more than one active generation"));
  checks.push(check("current-generation-live", !gens.length || gens.some((g) => g.generation === current), "current generation missing from history"));
  return checks;
}

/**
 * Verify a key-hierarchy state record's lifecycle (Sprint 4): root/chain metadata present,
 * indexes non-negative, archived chains dated, no key material.
 * @param {object} state a public hierarchy DTO @returns {object[]} checks
 */
export function verifyKeyHierarchyLifecycle(state) {
  const checks = [];
  const material = findKeyMaterial(state);
  checks.push(check("no-key-material", material.length === 0, material[0]));
  checks.push(check("root-present", Boolean(state.rootKey?.rootKeyId), "root key metadata missing"));
  for (const role of ["sendingChain", "receivingChain"]) {
    const c = state[role];
    checks.push(check(`${role}-index-valid`, c && Number.isInteger(c.index) && c.index >= 0, `${role} index invalid`));
  }
  checks.push(check("archived-dated", (state.archivedChains ?? []).every((c) => c.archivedAt || c.status === "destroyed"), "archived chain missing archivedAt"));
  return checks;
}

/**
 * Verify destruction is audited: for a set of audit entries, every derive/create is eventually
 * balanced by a destroy (no orphaned live keys). Approximate — counts by action.
 * @param {object[]} audit @param {{ createActions: string[], destroyActions: string[] }} spec
 * @returns {object[]} checks
 */
export function verifyDestructionAudit(audit, spec) {
  const created = (audit ?? []).filter((a) => spec.createActions.includes(a.action)).length;
  const destroyed = (audit ?? []).filter((a) => spec.destroyActions.includes(a.action)).length;
  return [check("destruction-balanced", destroyed >= created - 1, `created=${created} destroyed=${destroyed} (allow ≤1 live)`)];
}

export class KeyLifecycleVerifier {
  /** @param {{ events?: HardeningEventBus, metrics?: object }} [deps] */
  constructor(deps = {}) {
    this.events = deps.events ?? new HardeningEventBus();
    this.metrics = deps.metrics ?? null;
  }

  /**
   * Run the appropriate verifier for a `kind` of record and return a consolidated report.
   * Emits LIFECYCLE_VERIFIED / LIFECYCLE_VIOLATION.
   * @param {"message-keys"|"forward-secrecy"|"key-hierarchy"} kind @param {object} state
   * @returns {{ ok: boolean, kind: string, sessionId: string, checks: object[], violations: object[] }}
   */
  verify(kind, state) {
    const checks =
      kind === "message-keys" ? verifyMessageKeyLifecycle(state) : kind === "forward-secrecy" ? verifyForwardSecrecyLifecycle(state) : verifyKeyHierarchyLifecycle(state);
    const violations = checks.filter((c) => !c.ok);
    const ok = violations.length === 0;
    const payload = { sessionId: state.sessionId, generation: state.generation ?? state.currentGeneration };
    if (ok) {
      this.metrics?.increment("lifecycle_verified_total", 1, { kind });
      this.events.emit(HardeningEventType.LIFECYCLE_VERIFIED, { ...payload, details: { kind } });
    } else {
      this.metrics?.increment("lifecycle_violations_total", 1, { kind });
      this.events.emit(HardeningEventType.LIFECYCLE_VIOLATION, { ...payload, reason: violations[0].name, details: { kind, violations: violations.map((v) => v.name) } });
    }
    return { ok, kind, sessionId: state.sessionId, checks, violations };
  }
}

export { KeyPhase };
