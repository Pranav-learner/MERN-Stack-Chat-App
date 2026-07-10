/**
 * @module session-integration/validators
 *
 * Input + participant validation for the integration layer. Keeps the pipeline and
 * middleware honest without duplicating the Sprint 3 session validation (which the
 * SessionGuard/manager already perform).
 */

import { PipelineInputError, SessionMismatchError } from "../errors.js";

/**
 * Validate the shape of a pipeline input (sender, recipient/groupId, message).
 * @param {{ sender?: string, recipient?: string, groupId?: string, message?: object }} input
 * @throws {PipelineInputError}
 */
export function validatePipelineInput(input) {
  if (!input || typeof input !== "object") {
    throw new PipelineInputError("Pipeline input must be an object");
  }
  if (!input.sender) throw new PipelineInputError("Pipeline input requires a sender");
  if (!input.recipient && !input.groupId) {
    throw new PipelineInputError("Pipeline input requires a recipient or groupId");
  }
  if (input.recipient && String(input.sender) === String(input.recipient)) {
    throw new PipelineInputError("Cannot message yourself");
  }
  if (input.message !== undefined && (input.message === null || typeof input.message !== "object")) {
    throw new PipelineInputError("Pipeline message must be an object");
  }
  return input;
}

/**
 * Assert a resolved session actually binds the two participants (defence against a
 * mixed-up/mismatched session).
 * @param {object} session a session DTO @param {string} sender @param {string} recipient
 * @throws {SessionMismatchError}
 */
export function assertSessionMatchesPair(session, sender, recipient) {
  const parts = (session.participants ?? []).map(String);
  if (!parts.includes(String(sender)) || !parts.includes(String(recipient))) {
    throw new SessionMismatchError("Resolved session does not bind both participants", {
      details: { sessionId: session.sessionId, participants: parts },
    });
  }
  return true;
}

/** A stable, order-independent key for a participant pair (for caching/dedup). */
export function pairKey(a, b) {
  return [String(a), String(b)].sort().join("::");
}
