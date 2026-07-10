/**
 * @module session-evolution/integration/bridge
 *
 * **Application Integration** — the bridge that makes the chat backend AWARE that
 * Secure Sessions have generations, without any key rotation. It subscribes to a
 * {@link module:shs/session/events SessionEventBus} and mirrors session lifecycle events
 * into the Session Evolution Framework:
 *
 * - a session is created/activated → an evolution record is created (generation 0);
 * - a session is rekeyed (Layer 4 framework) → the evolution generation is advanced
 *   (metadata only — the actual key move already happened in Layer 4);
 * - a session is closed/destroyed → evolution tracking is retired.
 *
 * The bridge is ADDITIVE and defensive: a failure to mirror an event is logged and
 * swallowed so it can never break the session flow. It performs NO cryptography.
 *
 * @example
 * ```js
 * import { attachSessionEvolution } from "./session-evolution/index.js";
 * const detach = attachSessionEvolution({ sessionEvents: secureSessionEvents, evolutionManager });
 * // ... later: detach();
 * ```
 */

import { EvolutionTrigger } from "../types/types.js";

/** Session event types this bridge reacts to (kept local to avoid a hard import cycle). */
const SESSION_EVENTS = Object.freeze({
  CREATED: "session.created",
  REKEYED: "session.rekeyed",
  CLOSED: "session.closed",
  DESTROYED: "session.destroyed",
  EXPIRED: "session.expired",
});

/**
 * Wire a {@link EvolutionManager} to a session event bus so evolution records track
 * session lifecycles automatically.
 *
 * @param {object} deps
 * @param {{ on: (type: string, handler: Function) => (() => void) }} deps.sessionEvents the SessionEventBus
 * @param {import("../manager/evolutionManager.js").EvolutionManager} deps.evolutionManager
 * @param {(scope: string, error: Error) => void} [deps.onError] error sink (defaults to console.error)
 * @returns {() => void} detach — unsubscribes all handlers
 */
export function attachSessionEvolution({ sessionEvents, evolutionManager, onError } = {}) {
  if (!sessionEvents || typeof sessionEvents.on !== "function") {
    throw new Error("attachSessionEvolution requires a sessionEvents bus with .on()");
  }
  if (!evolutionManager) throw new Error("attachSessionEvolution requires an evolutionManager");
  const report = onError ?? ((scope, error) => console.error(`[session-evolution] ${scope}:`, error?.message));

  const guard = (scope, fn) => (event) => {
    Promise.resolve()
      .then(() => fn(event))
      .catch((error) => report(scope, error));
  };

  const offs = [
    sessionEvents.on(
      SESSION_EVENTS.CREATED,
      guard("onSessionCreated", async (e) => {
        // Only create if absent — registerSession + establishSession both emit CREATED.
        const existing = await evolutionManager.findEvolutionState(e.sessionId);
        if (!existing) {
          await evolutionManager.createEvolutionState({ sessionId: e.sessionId, handshakeId: e.handshakeId });
        }
      }),
    ),
    sessionEvents.on(
      SESSION_EVENTS.REKEYED,
      guard("onSessionRekeyed", async (e) => {
        const existing = await evolutionManager.findEvolutionState(e.sessionId);
        if (existing && !existing.isRetired) {
          await evolutionManager.advanceGeneration(e.sessionId, {
            reason: "session-rekey",
            trigger: EvolutionTrigger.SESSION_REKEY,
          });
        }
      }),
    ),
    sessionEvents.on(SESSION_EVENTS.CLOSED, guard("onSessionClosed", (e) => retire(evolutionManager, e.sessionId, "session-closed"))),
    sessionEvents.on(SESSION_EVENTS.DESTROYED, guard("onSessionDestroyed", (e) => retire(evolutionManager, e.sessionId, "session-destroyed"))),
    sessionEvents.on(SESSION_EVENTS.EXPIRED, guard("onSessionExpired", (e) => retire(evolutionManager, e.sessionId, "session-expired"))),
  ];

  return () => offs.forEach((off) => off && off());
}

/** Retire an evolution record if it exists and is not already retired. */
async function retire(evolutionManager, sessionId, reason) {
  const existing = await evolutionManager.findEvolutionState(sessionId);
  if (existing && !existing.isRetired) await evolutionManager.retire(sessionId, { reason });
}

/**
 * Combine a Secure Session DTO with its evolution DTO into a single client-facing view,
 * so client state can render "this session is on generation N". Read-only; additive.
 * @param {object} session a public Secure Session DTO (may be null)
 * @param {object} evolution a public evolution DTO (may be null)
 * @returns {object}
 */
export function deriveGenerationView(session, evolution) {
  return {
    sessionId: session?.sessionId ?? evolution?.sessionId,
    status: session?.status,
    // Evolution-awareness — the app now understands sessions have generations.
    generation: evolution?.generation ?? 0,
    evolutionState: evolution?.state ?? null,
    keyVersion: evolution?.keyVersion ?? null,
    isEvolutionPending: evolution?.isPending ?? false,
    policies: (evolution?.policies ?? []).map((p) => ({ id: p.id, type: p.type })),
    // Explicitly advertise that no advanced crypto is active yet.
    security: {
      forwardSecrecy: evolution?.securityMetadata?.forwardSecrecy ?? false,
      ratcheting: evolution?.securityMetadata?.ratcheting ?? false,
    },
  };
}
