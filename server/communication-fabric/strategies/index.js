/**
 * @module communication-fabric/strategies
 *
 * Strategy barrel + the default {@link StrategyRegistry} factory. The registration ORDER here is the
 * deterministic tie-break the Decision Engine uses for equal scores, so it is intentional: the specific,
 * high-signal strategies (media, group, sync) precede the general ones (direct, offline), and the
 * placeholders (relay, hybrid) come last so they never displace a real match.
 */

import { StrategyRegistry } from "./strategy.js";
import { MediaStrategy } from "./mediaStrategy.js";
import { GroupStrategy } from "./groupStrategy.js";
import { SynchronizationStrategy } from "./synchronizationStrategy.js";
import { DirectCommunicationStrategy } from "./directStrategy.js";
import { OfflineStrategy } from "./offlineStrategy.js";
import { RelayStrategy } from "./relayStrategy.js";
import { HybridStrategy } from "./hybridStrategy.js";

export { BaseStrategy, StrategyRegistry, makeStep, nextStepId } from "./strategy.js";
export { MediaStrategy } from "./mediaStrategy.js";
export { GroupStrategy } from "./groupStrategy.js";
export { SynchronizationStrategy } from "./synchronizationStrategy.js";
export { DirectCommunicationStrategy } from "./directStrategy.js";
export { OfflineStrategy } from "./offlineStrategy.js";
export { RelayStrategy } from "./relayStrategy.js";
export { HybridStrategy } from "./hybridStrategy.js";

/**
 * Build the default strategy registry with every Sprint-1 strategy registered in priority order.
 * @returns {StrategyRegistry}
 */
export function createDefaultStrategyRegistry() {
  return new StrategyRegistry()
    .register(new MediaStrategy())
    .register(new GroupStrategy())
    .register(new SynchronizationStrategy())
    .register(new DirectCommunicationStrategy())
    .register(new OfflineStrategy())
    .register(new RelayStrategy())
    .register(new HybridStrategy());
}
