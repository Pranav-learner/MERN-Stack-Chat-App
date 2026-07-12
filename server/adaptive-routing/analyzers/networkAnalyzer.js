/**
 * @module adaptive-routing/analyzers/networkAnalyzer
 *
 * The **Network Analyzer** (STEP 5) — reports the AVAILABILITY of each communication substrate (connection,
 * transport, p2p, relay, sync) as a frozen **network analysis**. Availability is declared, not probed: a
 * deployment injects a `networkStateProvider(context)` (backed by Layer 6/7 connectivity), or passes a
 * per-request hint; absent both, every substrate defaults to AVAILABLE (or UNKNOWN → treated as available
 * but flagged) so the Fabric stays functional.
 *
 * **Sprint-2 explicitly does NOT probe the network.** Runtime QUALITY signals — quality, latency,
 * bandwidth, connection stability — are declared here as `null` PLACEHOLDERS. Sprint 3 (resource
 * optimization) supplies a real provider that fills them in; the scorers already reserve zero-weight
 * dimensions for them, so nothing structural changes.
 *
 * @security Reports substrate availability booleans + null placeholders only. No content, no addresses.
 */

import { deepFreeze } from "../_fabric.js";
import { Availability, NetworkSubstrate, AdaptiveEventType } from "../types/types.js";

export class NetworkAnalyzer {
  /**
   * @param {object} [deps]
   * @param {(context: object) => object} [deps.networkStateProvider] service-agnostic availability resolver
   * @param {import("../events/events.js").AdaptiveEventBus} [deps.events]
   */
  constructor(deps = {}) {
    this.networkStateProvider = deps.networkStateProvider ?? null;
    this.events = deps.events ?? null;
  }

  /**
   * Analyze substrate availability for a communication.
   * @param {object} context Sprint-1 context
   * @param {object} [opts] @param {object} [opts.hint] per-request availability hint `{ connection, transport, p2p, relay, sync }`
   * @returns {object} frozen network analysis
   */
  analyze(context, opts = {}) {
    // provider (if wired) is the base; the per-request hint overrides individual substrates
    let base = {};
    if (this.networkStateProvider) {
      try {
        base = this.networkStateProvider(context) ?? {};
      } catch {
        base = {};
      }
    }
    const hint = opts.hint ?? {};

    const availability = {
      [NetworkSubstrate.CONNECTION]: resolve(base.connection ?? hint.connection),
      [NetworkSubstrate.TRANSPORT]: resolve(base.transport ?? hint.transport),
      [NetworkSubstrate.P2P]: resolve(base.p2p ?? hint.p2p),
      [NetworkSubstrate.RELAY]: resolve(base.relay ?? hint.relay),
      [NetworkSubstrate.SYNC]: resolve(base.sync ?? hint.sync),
    };

    const analysis = deepFreeze({
      availability,
      // --- runtime QUALITY placeholders — Sprint 3 fills these; NO probing in Sprint 2 ---
      quality: null,
      latencyMs: null,
      bandwidthKbps: null,
      stability: null,
      probed: false,
      analyzedAt: context.raw?.execution?.createdAt ?? null,
    });

    this.events?.emit(AdaptiveEventType.NETWORK_ANALYZED, { requestId: context.requestId, availability });
    return analysis;
  }
}

/** Coerce a value into an {@link Availability}; a missing/unknown substrate defaults to AVAILABLE. */
function resolve(v) {
  if (v === true || v === Availability.AVAILABLE) return Availability.AVAILABLE;
  if (v === false || v === Availability.UNAVAILABLE) return Availability.UNAVAILABLE;
  if (v === Availability.UNKNOWN) return Availability.UNKNOWN;
  // default: assume the substrate is available (Sprint 2 is optimistic; Sprint 3 measures)
  return Availability.AVAILABLE;
}

/** Is a substrate usable (available or unknown-but-optimistic)? Used by candidate filtering. */
export function isUsable(availability) {
  return availability === Availability.AVAILABLE || availability === Availability.UNKNOWN;
}
