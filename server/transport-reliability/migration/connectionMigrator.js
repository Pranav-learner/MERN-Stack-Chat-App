/**
 * @module transport-reliability/migration
 *
 * **Connection migration.** Moves an in-flight transfer from a dead/changed Active Connection onto a
 * new one WITHOUT restarting it: the transfer's checkpoint is preserved, the new connection is
 * validated, the transport is switched (via injected Layer-7 hooks), and the transfer continues from
 * where it left off. Handles a device network change (WiFi ↔ mobile), a Layer-7 connection
 * replacement, and a manual migration.
 *
 * @integration This is the seam to Layer 7's Connection Manager: `validateConnection` + `switch
 * connection` are INJECTED hooks the deployment wires to the real connection layer. Defaults are
 * optimistic (accept the new connection) so the subsystem is testable + transport-independent.
 *
 * @security Migration moves CONTROL-PLANE state only (which connection carries the transfer). The
 * transfer's crypto session + payload are untouched; a migration is a transport swap, not a re-
 * handshake. The checkpoint is preserved verbatim so no chunk is lost or re-sent incorrectly.
 */

import { MigrationTrigger, MigrationOutcome, RecoveryTrigger } from "../types/types.js";

export class ConnectionMigrator {
  /** @param {{ clock?: () => number }} [deps] */
  constructor(deps = {}) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * Migrate a transfer onto a new Active Connection. Pure-ish: it calls the injected hooks and returns
   * a structured result; the manager applies state + persistence.
   *
   * @param {object} params
   * @param {import("../types/types.js").TransferReliabilityRecord} params.record
   * @param {string} params.newConnectionId @param {string} [params.trigger] one of {@link MigrationTrigger}
   * @param {{ validateConnection?: Function, switchConnection?: Function }} [params.hooks]
   * @returns {Promise<{ outcome: string, connectionId: string|null, previousConnectionId: string|null, trigger: string, checkpointPreserved: boolean, migratedAt: string }>}
   */
  async migrate({ record, newConnectionId, trigger = MigrationTrigger.MANUAL, hooks = {} }) {
    const previousConnectionId = record.connectionId ?? null;
    const migratedAt = new Date(this.clock()).toISOString();
    if (!newConnectionId || String(newConnectionId) === String(previousConnectionId)) {
      return { outcome: MigrationOutcome.REJECTED, connectionId: previousConnectionId, previousConnectionId, trigger, checkpointPreserved: true, migratedAt, reason: "no-new-connection" };
    }

    // Validate the target connection (Layer 7 hook). A rejection leaves the transfer untouched.
    const valid = await safe(hooks.validateConnection, record, newConnectionId, trigger);
    if (!valid) return { outcome: MigrationOutcome.REJECTED, connectionId: previousConnectionId, previousConnectionId, trigger, checkpointPreserved: true, migratedAt, reason: "validation-failed" };

    // Switch the transport (Layer 7 hook). Failure leaves the transfer on its old connection.
    const switched = await safe(hooks.switchConnection, record, newConnectionId, trigger);
    if (!switched) return { outcome: MigrationOutcome.FAILED, connectionId: previousConnectionId, previousConnectionId, trigger, checkpointPreserved: true, migratedAt, reason: "switch-failed" };

    return { outcome: MigrationOutcome.MIGRATED, connectionId: String(newConnectionId), previousConnectionId, trigger, checkpointPreserved: true, migratedAt };
  }

  /** Map a device network-change hint to the migration trigger (WiFi ↔ mobile). */
  static triggerForNetworkChange(from, to) {
    const f = String(from ?? "").toLowerCase();
    const t = String(to ?? "").toLowerCase();
    if (f.includes("wifi") && (t.includes("mobile") || t.includes("cellular"))) return MigrationTrigger.WIFI_TO_MOBILE;
    if ((f.includes("mobile") || f.includes("cellular")) && t.includes("wifi")) return MigrationTrigger.MOBILE_TO_WIFI;
    return MigrationTrigger.CONNECTION_REPLACED;
  }

  /** Whether a recovery trigger implies a migration (rather than an in-place resume). */
  static isMigrationTrigger(recoveryTrigger) {
    return recoveryTrigger === RecoveryTrigger.CONNECTION_LOSS || recoveryTrigger === RecoveryTrigger.NETWORK_CHANGE;
  }
}

async function safe(hook, ...args) {
  if (typeof hook !== "function") return true; // no hook → accept (device/Layer-7 confirms out of band)
  try {
    return (await hook(...args)) !== false;
  } catch {
    return false;
  }
}
