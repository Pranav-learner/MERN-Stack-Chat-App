/**
 * @module key-hierarchy/metadata
 *
 * Metadata blocks for the key hierarchy — hierarchy summary + security posture. Keeps the
 * derived summaries on a hierarchy record consistent after each mutation.
 *
 * @security Metadata is PUBLIC descriptors + counters only — never key material.
 */

import { KH_KDF, KH_KEY_BYTES, KH_VERSION, KH_SCHEMA_VERSION } from "../types/types.js";

/**
 * Summary of a hierarchy's shape (generation, chain indexes, archived count).
 * @param {import("../types/types.js").KeyHierarchyState} record @returns {object}
 */
export function createHierarchyMetadata(record) {
  return {
    generation: record.generation ?? 0,
    rootKeyId: record.rootKey?.rootKeyId ?? null,
    sendingIndex: record.sendingChain?.index ?? 0,
    receivingIndex: record.receivingChain?.index ?? 0,
    archivedChains: (record.archivedChains ?? []).length,
    rootVersions: (record.rootHistory ?? []).length,
  };
}

/** Security posture metadata for the key hierarchy. */
export function createSecurityMetadata() {
  return {
    kdf: KH_KDF,
    keyBytes: KH_KEY_BYTES,
    schemeVersion: KH_VERSION,
    schemaVersion: KH_SCHEMA_VERSION,
    hierarchical: true,
    oneWayChains: true,
    forwardSecrecy: true, // inherited from the Sprint 2 re-rooting
    // Explicitly NOT implemented in this sprint:
    perMessageKeys: false,
    doubleRatchet: false,
    postCompromiseSecurity: false,
  };
}

/**
 * Recompute the derived metadata block from a live record.
 * @param {import("../types/types.js").KeyHierarchyState} record @returns {{ hierarchy: object }}
 */
export function recomputeMetadata(record) {
  return { hierarchy: createHierarchyMetadata(record) };
}
