/**
 * @module session-integration/services/messagePipeline
 *
 * The **message pipeline** — the transport-independent flow every messaging operation
 * runs through:
 *
 * ```
 * Message → Resolve Session → Validate Session → Prepare Secure Payload → Transport → Receiver
 * ```
 *
 * The `transport` is injected (REST persist+emit, socket emit, or a test double), so
 * the pipeline is reusable across transports. The "Prepare Secure Payload" stage runs
 * the encryption interceptor, which is a NO-OP in Sprint 5 (the extension point Layer 5
 * fills). In PERMISSIVE mode a missing/invalid session falls back (unencrypted, flagged
 * + counted); in STRICT mode the pipeline rejects with {@link HandshakeRequiredError}.
 *
 * @security No encryption in Sprint 5. The pipeline never sees keys; it attaches key
 * METADATA and hands the payload to the (currently no-op) interceptor.
 */

import { PipelineStage, IntegrationEventType } from "../types.js";
import { validatePipelineInput, assertSessionMatchesPair } from "../validators/sessionValidators.js";
import { prepareSecurePayload } from "../transport/securePayload.js";
import { HandshakeRequiredError, TransportUnavailableError } from "../errors.js";

export class MessagePipeline {
  /**
   * @param {object} deps
   * @param {import("../manager/applicationSessionManager.js").ApplicationSessionManager} deps.appSessions
   * @param {object} [deps.events] the integration event bus (defaults to the manager's)
   * @param {object} [deps.interceptor] override the active encryption interceptor
   */
  constructor(deps) {
    if (!deps || !deps.appSessions) throw new Error("MessagePipeline requires { appSessions }");
    this.appSessions = deps.appSessions;
    this.events = deps.events ?? deps.appSessions.events;
    this.interceptor = deps.interceptor ?? null;
  }

  /**
   * Run a message through the pipeline.
   *
   * @param {object} input
   * @param {string} input.sender @param {string} [input.recipient] @param {string} [input.groupId]
   * @param {object} input.message the message body (e.g. `{ text, image }`)
   * @param {(envelope: object, context: object) => Promise<any>} input.transport delivers the envelope
   * @returns {Promise<{ context: object, envelope: object, delivery: any, stage: string }>}
   * @throws {HandshakeRequiredError} in STRICT mode when no valid session exists
   * @throws {PipelineInputError | TransportUnavailableError}
   */
  async process(input) {
    validatePipelineInput(input);
    if (typeof input.transport !== "function") {
      throw new TransportUnavailableError("A transport function is required");
    }

    // 1. Resolve + 2. Validate (both inside sessionContext).
    const context = await this.appSessions.sessionContext(input.sender, input.recipient, { groupId: input.groupId });

    // Enforcement gate (STRICT only).
    if (this.appSessions.shouldReject(context)) {
      this._emit(IntegrationEventType.PIPELINE_REJECTED, context, { stage: PipelineStage.VALIDATE });
      throw new HandshakeRequiredError(undefined, { details: { sender: input.sender, recipient: input.recipient } });
    }

    // Defence-in-depth: a resolved session must actually bind the pair.
    if (context.resolved && input.recipient) {
      assertSessionMatchesPair({ sessionId: context.sessionId, participants: context.participants }, input.sender, input.recipient);
    }

    // 3. Prepare secure payload (encryption HOOK — no-op in Sprint 5).
    const envelope = await prepareSecurePayload(input.message, context, this.interceptor ? { interceptor: this.interceptor } : {});
    this._emit(IntegrationEventType.TRANSPORT_READY, context, { stage: PipelineStage.PREPARE, secured: envelope.secured });

    // 4. Transport → Receiver.
    let delivery;
    try {
      delivery = await input.transport(envelope, context);
    } catch (error) {
      throw new TransportUnavailableError("Transport failed", { cause: error, details: { sessionId: context.sessionId } });
    }

    // 5. Done.
    this._emit(IntegrationEventType.MESSAGE_PIPELINED, context, { stage: PipelineStage.DELIVERED, transportMode: context.transportMode });
    if (context.fallback) this._emit(IntegrationEventType.PIPELINE_FALLBACK, context, { stage: PipelineStage.DELIVERED });

    return { context, envelope, delivery, stage: PipelineStage.DELIVERED };
  }

  /** @private */
  _emit(type, context, details) {
    this.events?.emit(type, {
      sessionId: context.sessionId,
      initiator: context.initiator,
      peer: context.peer,
      resolution: context.resolution,
      transportMode: context.transportMode,
      details,
    });
  }
}
