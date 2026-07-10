/**
 * @module controllers/messageKeyController
 *
 * HTTP handlers for the **Per-Message Key** subsystem (Layer 5, Sprint 5). Per-message keys
 * are EPHEMERAL + device-local (derived, used once, and wiped on-device), so the server never
 * holds or sees them. The server stores + exposes per-session message METADATA (counters,
 * message numbers, key ids, fingerprints, delivery status) that devices report.
 *
 * These endpoints are READ-ONLY plus a device REPORT endpoint that records message metadata a
 * device produced locally. All routes sit behind `protectedRoute` (JWT) and enforce session
 * participation.
 */

import { MessageKeyError } from "../message-keys/errors.js";
import { MessageKeyEventBus } from "../message-keys/events/events.js";
import { createMongoMessageKeyRepository } from "../message-keys/repository/mongoMessageKeyRepository.js";
import { createMessageMeta, createSecurityMetadata, recomputeMetadata } from "../message-keys/metadata/metadata.js";
import { auditEntry, appendAudit, AuditAction } from "../message-keys/audit/audit.js";
import { toPublicMessageKeyState, toMessageKeyStatus, toPublicMessageMeta } from "../message-keys/serialization/serializer.js";
import { MessageDirection, DeliveryStatus, MK_SCHEMA_VERSION } from "../message-keys/types/types.js";
import { sessionManager } from "./secureSessionController.js";

/** Shared message-key event bus — Sprint 6 hardening subscribes here. */
export const messageKeyEvents = new MessageKeyEventBus();

const { messageKeys: repo } = createMongoMessageKeyRepository();

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof MessageKeyError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

async function authorizeSession(req, res, sessionId) {
  try {
    return await sessionManager.getSession(sessionId, { actingUser: callerId(req) });
  } catch (error) {
    if (error?.status) res.status(error.status).json({ success: false, code: error.code, message: error.message });
    else res.status(500).json({ success: false, message: "Internal Server Error" });
    return null;
  }
}

/** Ensure a metadata record exists for a session. */
async function ensure(sessionId, session) {
  const existing = await repo.findBySessionId(sessionId);
  if (existing) return existing;
  const at = new Date().toISOString();
  const record = {
    sessionId: String(sessionId),
    handshakeId: session?.handshakeId,
    generation: 0,
    sending: { count: 0, lastNumber: -1 },
    receiving: { count: 0, lastNumber: -1, highestNumber: -1 },
    messages: [],
    audit: [],
    security: createSecurityMetadata(),
    createdAt: at,
    updatedAt: at,
    schemaVersion: MK_SCHEMA_VERSION,
  };
  record.metadata = recomputeMetadata(record);
  return repo.create(record);
}

/**
 * POST /api/message-keys/:sessionId/report — record a device-produced message's METADATA.
 * Body: { direction, generation, messageNumber, keyId?, fingerprint?, delivery? }. NO keys.
 */
export const reportMessage = async (req, res) => {
  try {
    const session = await authorizeSession(req, res, req.params.sessionId);
    if (!session) return;
    const body = req.body ?? {};
    const state = await ensure(req.params.sessionId, session);
    const direction = body.direction === MessageDirection.RECEIVING ? MessageDirection.RECEIVING : MessageDirection.SENDING;
    const meta = createMessageMeta({
      sessionId: req.params.sessionId,
      direction,
      generation: body.generation ?? state.generation ?? 0,
      messageNumber: body.messageNumber,
      keyId: body.keyId,
      fingerprint: body.fingerprint,
      delivery: body.delivery ?? (direction === MessageDirection.SENDING ? DeliveryStatus.ENCRYPTED : DeliveryStatus.DECRYPTED),
    });
    const messages = [...(state.messages ?? []), meta].slice(-500);
    const patch = { messages, updatedAt: new Date().toISOString() };
    if (direction === MessageDirection.SENDING) patch.sending = { count: (state.sending?.count ?? 0) + 1, lastNumber: meta.messageNumber };
    else patch.receiving = { count: (state.receiving?.count ?? 0) + 1, lastNumber: meta.messageNumber, highestNumber: Math.max(state.receiving?.highestNumber ?? -1, meta.messageNumber) };
    patch.metadata = recomputeMetadata({ ...state, ...patch });
    patch.audit = appendAudit(state.audit, auditEntry(direction === MessageDirection.SENDING ? AuditAction.ENCRYPTED : AuditAction.DECRYPTED, { at: patch.updatedAt, direction, generation: meta.generation, messageNumber: meta.messageNumber, keyId: meta.keyId }));
    const updated = await repo.update(req.params.sessionId, patch);
    return res.status(200).json({ success: true, messageKeys: toPublicMessageKeyState(updated) });
  } catch (error) {
    return handleError(res, error, "reportMessage");
  }
};

/** GET /api/message-keys/:sessionId — full message-key state (metadata only). */
export const getState = async (req, res) => {
  try {
    const session = await authorizeSession(req, res, req.params.sessionId);
    if (!session) return;
    const state = await ensure(req.params.sessionId, session);
    return res.status(200).json({ success: true, messageKeys: toPublicMessageKeyState(state, { includeMessages: true }) });
  } catch (error) {
    return handleError(res, error, "getState");
  }
};

/** GET /api/message-keys/:sessionId/status — compact counts. */
export const getStatus = async (req, res) => {
  try {
    const session = await authorizeSession(req, res, req.params.sessionId);
    if (!session) return;
    const state = await ensure(req.params.sessionId, session);
    return res.status(200).json({ success: true, status: toMessageKeyStatus(state) });
  } catch (error) {
    return handleError(res, error, "getStatus");
  }
};

/** GET /api/message-keys/:sessionId/messages — recent message metadata. */
export const getMessages = async (req, res) => {
  try {
    const session = await authorizeSession(req, res, req.params.sessionId);
    if (!session) return;
    const state = await ensure(req.params.sessionId, session);
    return res.status(200).json({ success: true, messages: (state.messages ?? []).map(toPublicMessageMeta) });
  } catch (error) {
    return handleError(res, error, "getMessages");
  }
};
