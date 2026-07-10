/**
 * @module evolution-policy/metadata
 *
 * Metadata blocks for the automatic-rekey engine — policy metadata, execution metadata,
 * and security metadata. Keeps the derived summaries on a policy-state record consistent
 * after each mutation.
 *
 * @security Metadata is PUBLIC descriptors + counters only — never key material.
 */

import { REKEY_SCHEMA_VERSION } from "../types/types.js";

/**
 * Summary of a session's attached policies.
 * @param {import("../../session-evolution/types/types.js").PolicyDescriptor[]} [policies]
 * @param {{ at?: string|null }} [options] @returns {object}
 */
export function createPolicyMetadata(policies = [], options = {}) {
  const list = policies ?? [];
  return {
    count: list.length,
    types: [...new Set(list.map((p) => p.type))],
    enabled: list.filter((p) => p.enabled !== false).length,
    lastConfiguredAt: options.at ?? null,
  };
}

/**
 * Summary of a session's rekey execution activity.
 * @param {import("../types/types.js").RekeyExecution[]} [executions]
 * @param {{ lastRekeyAt?: string|null }} [options] @returns {object}
 */
export function createExecutionMetadata(executions = [], options = {}) {
  const list = executions ?? [];
  const byState = {};
  for (const e of list) byState[e.state] = (byState[e.state] ?? 0) + 1;
  return {
    total: list.length,
    byState,
    completed: byState.completed ?? 0,
    failed: byState.failed ?? 0,
    lastRekeyAt: options.lastRekeyAt ?? null,
  };
}

/** Security posture metadata for the automatic-rekey engine. */
export function createSecurityMetadata(config = {}) {
  return {
    automaticRekeying: true,
    forwardSecrecy: true, // delegated to the Sprint 2 engine
    cooldownMs: config.cooldownMs ?? null,
    deduplication: "generation-based",
    schemaVersion: REKEY_SCHEMA_VERSION,
    // Explicitly NOT implemented in this sprint:
    chainKeys: false,
    messageKeys: false,
    doubleRatchet: false,
    postCompromiseSecurity: false,
  };
}

/**
 * Recompute the derived metadata blocks from a live record.
 * @param {import("../types/types.js").RekeyPolicyState} record @param {{ at?: string|null }} [options]
 * @returns {{ policyMetadata: object, executionMetadata: object }}
 */
export function recomputeMetadata(record, options = {}) {
  return {
    policyMetadata: createPolicyMetadata(record.policies, { at: options.at ?? record.metadata?.policy?.lastConfiguredAt ?? null }),
    executionMetadata: createExecutionMetadata(record.executions, { lastRekeyAt: record.lastRekeyAt ?? null }),
  };
}
