/**
 * Test helpers for the Secure Session Integration layer. Node built-ins only (no
 * MongoDB, no external deps). Not a test file.
 */

import crypto from "node:crypto";
import { ApplicationSessionManager } from "../manager/applicationSessionManager.js";
import { MessagePipeline } from "../services/messagePipeline.js";
import { createSessionMiddleware } from "../middleware/sessionMiddleware.js";
import { SecureSessionManager } from "../../shs/session/manager/sessionManager.js";
import { createInMemorySessionRepository } from "../../shs/session/repository/inMemoryRepository.js";
import { SecureKeyStore } from "../../shs/session/storage/secureKeyStore.js";
import { SessionGuard } from "../../shs/hardening/session-guard/sessionGuard.js";

export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const c = () => now;
  c.advance = (ms) => (now += ms);
  return c;
}

/**
 * Build the full integration stack over an in-memory, device-mode SecureSessionManager
 * so tests can establish real sessions.
 * @param {{ enforcement?: string, withGuard?: boolean, maxLifetimeMs?: number, idleTimeoutMs?: number }} [options]
 */
export function makeStack(options = {}) {
  const clock = makeClock();
  const secure = new SecureSessionManager({
    ...createInMemorySessionRepository(),
    keyStore: new SecureKeyStore(),
    clock,
    maxLifetimeMs: options.maxLifetimeMs ?? 100_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 50_000,
  });
  const guard = options.withGuard ? new SessionGuard({ clock }) : null;
  const appSessions = new ApplicationSessionManager({ sessions: secure, guard, clock, enforcement: options.enforcement });
  const pipeline = new MessagePipeline({ appSessions });
  const middleware = createSessionMiddleware({ appSessions, peerParam: "id" });
  return { clock, secure, appSessions, pipeline, middleware };
}

/** Establish a real session between two users (device mode). */
export async function establishBetween(appSessions, a, b, over = {}) {
  return appSessions.createIfMissing(a, b, {
    handshakeId: over.handshakeId ?? `hs-${a}-${b}`,
    sharedSecret: over.sharedSecret ?? crypto.randomBytes(32),
    deviceIds: over.deviceIds ?? { initiator: `dev-${a}`, responder: `dev-${b}` },
  });
}

/** A payload-agnostic test transport that records deliveries. */
export function recordingTransport() {
  const delivered = [];
  const transport = async (envelope, context) => {
    const record = {
      secured: envelope.secured,
      transportMode: envelope.transportMode,
      fallback: envelope.fallback,
      sessionId: envelope.sessionId,
      keyId: envelope.keyId,
      resolution: context.resolution,
    };
    delivered.push(record);
    return { id: `m${delivered.length}`, ...record };
  };
  transport.delivered = delivered;
  return transport;
}

/** Minimal Express-style req/res/next doubles. */
export function fakeReq(userId, params = {}, body = {}) {
  return { user: { _id: userId }, params, body };
}
export function fakeRes() {
  const res = { statusCode: 200, body: null, responded: false };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    res.responded = true;
    return res;
  };
  return res;
}

/**
 * Run a single middleware and resolve to `{ nexted, res }`. Resolves when the
 * middleware calls `next()` (nexted=true) or writes a response (nexted=false).
 */
export async function runMiddleware(mw, req, res) {
  let nexted = false;
  await new Promise((resolve) => {
    const next = () => {
      nexted = true;
      resolve();
    };
    const maybe = mw(req, res, next);
    if (maybe && typeof maybe.then === "function") {
      maybe.then(() => resolve()).catch(() => resolve());
    } else if (res.responded) {
      resolve();
    }
  });
  return { nexted: nexted && !res.responded, res };
}
