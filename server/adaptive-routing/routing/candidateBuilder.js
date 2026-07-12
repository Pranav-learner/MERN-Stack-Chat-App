/**
 * @module adaptive-routing/routing/candidateBuilder
 *
 * The **Candidate Route Builder** — enumerates the candidate `(strategy, route)` pairs the scorer will
 * rank. It draws candidates from the frozen Sprint-1 strategy registry (every strategy that `supports`
 * the context contributes its primary route) and ADDITIVELY injects an ADAPTIVE relay candidate for
 * eligible messaging — so the adaptive layer can consider relaying WITHOUT modifying the Sprint-1 relay
 * strategy (which only self-selects when forced). Candidate enumeration is capability/network-agnostic;
 * viability is decided later by the scorers, so every option (and why it lost) stays explainable.
 *
 * @security Candidates are `(strategyType, routeKind, subsystems)` control-plane tuples. No content.
 */

import { StrategyType, RouteKind, ConversationType, MediaType, TransportCapability, NetworkSubstrate } from "../types/types.js";
import { supportsTransport } from "../capability/capabilityProfile.js";
import { isUsable } from "../analyzers/networkAnalyzer.js";

export class CandidateBuilder {
  /** @param {object} deps @param {import("../../communication-fabric/index.js").StrategyRegistry} deps.strategyRegistry */
  constructor(deps = {}) {
    if (!deps.strategyRegistry) throw new Error("CandidateBuilder requires a strategyRegistry");
    this.strategyRegistry = deps.strategyRegistry;
  }

  /**
   * Build candidate routes for a context.
   * @param {object} context Sprint-1 context
   * @param {object} bundle @param {object} bundle.capabilities negotiated profile @param {object} bundle.network network analysis
   * @returns {{ strategyType: string, routeKind: string, subsystems: string[], adaptive: boolean }[]}
   */
  build(context, bundle = {}) {
    const raw = context.raw ?? context;
    const seen = new Set();
    const candidates = [];

    const add = (strategyType, routeKind, subsystems, adaptive = false) => {
      const key = `${strategyType}::${routeKind}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ strategyType, routeKind, subsystems: subsystems ?? [], adaptive });
    };

    // 1) every Sprint-1 strategy that supports the context contributes its primary route
    for (const { type, strategy } of this.strategyRegistry.candidates(context)) {
      let shape;
      try {
        shape = strategy.describe(context, { constraints: {} });
      } catch {
        continue;
      }
      add(type, shape.primaryRoute, shape.subsystems, false);
    }

    // 2) ADAPTIVE relay candidate — injected for direct/broadcast text when relay is capable + usable,
    //    even though the Sprint-1 relay strategy only self-selects when forced. This is what lets the
    //    adaptive layer *decide* whether to relay (STEP 7) without touching Sprint 1.
    const isMessaging = (raw.conversation.type === ConversationType.DIRECT || raw.conversation.type === ConversationType.BROADCAST) && raw.media.type === MediaType.NONE;
    const relayCapable = supportsTransport(bundle.capabilities ?? {}, TransportCapability.RELAY);
    const relayUsable = isUsable(bundle.network?.availability?.[NetworkSubstrate.RELAY]);
    if (isMessaging && relayCapable && relayUsable && !seen.has(`${StrategyType.RELAY}::${RouteKind.RELAYED_TRANSPORT}`)) {
      add(StrategyType.RELAY, RouteKind.RELAYED_TRANSPORT, ["connectivity", "messaging"], true);
    }

    return candidates;
  }
}
