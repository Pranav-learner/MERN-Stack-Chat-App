/**
 * @module session-integration
 *
 * Public entry point of the **Secure Session Integration** layer — Layer 4, Sprint 5.
 * Makes the production chat backend session-aware: every messaging operation resolves,
 * validates, and runs through a Secure Session (Sprint 3) before transport, with an
 * unused encryption HOOK that Layer 5 fills.
 *
 * ## Out of scope (Layer 5)
 * NO message/transport encryption, NO forward secrecy, NO ratchet. The app becomes
 * session-AWARE; encryption is a swap-in interceptor away.
 *
 * @example Wiring
 * ```js
 * import {
 *   ApplicationSessionManager, MessagePipeline, createSessionMiddleware,
 * } from "./session-integration/index.js";
 * const appSessions = new ApplicationSessionManager({ sessions: secureSessionManager, guard });
 * const pipeline = new MessagePipeline({ appSessions });
 * const { resolveSession, refreshSession } = createSessionMiddleware({ appSessions });
 * ```
 */

// Manager + repository
export { ApplicationSessionManager, IntegrationMetric } from "./manager/applicationSessionManager.js";
export { SessionContextRepository } from "./repositories/sessionContextRepository.js";

// Pipeline + middleware + adapters
export { MessagePipeline } from "./services/messagePipeline.js";
export { createSessionMiddleware } from "./middleware/sessionMiddleware.js";
export { pipelineInputFromRequest, makeRestTransport } from "./adapters/restAdapter.js";
export { attachSocketSessionContext, resolveSocketSession, withSessionMetadata } from "./adapters/socketAdapter.js";

// Transport + encryption hook
export { prepareSecurePayload, openSecurePayload, sessionMetadataOf } from "./transport/securePayload.js";
export {
  NoopEncryptionInterceptor,
  getEncryptionInterceptor,
  setEncryptionInterceptor,
  resetEncryptionInterceptor,
  isEncryptionActive,
} from "./interceptors/encryptionInterceptor.js";

// Validators + events
export { validatePipelineInput, assertSessionMatchesPair, pairKey } from "./validators/sessionValidators.js";
export { SessionIntegrationEventBus } from "./events/events.js";

// Errors + types
export * from "./errors.js";
export {
  PipelineStage,
  SessionResolution,
  TransportMode,
  EnforcementMode,
  IntegrationEventType,
  FailureMode,
  ENVELOPE_VERSION,
} from "./types.js";
