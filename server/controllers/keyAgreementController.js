/**
 * @module controllers/keyAgreementController
 *
 * HTTP handlers for Secure Key Agreement (Layer 4, Sprint 2). The server is a
 * **relay only**: it coordinates the exchange of PUBLIC ephemeral keys and one-way
 * commitments and drives the handshake state — it NEVER generates ephemeral keys,
 * NEVER derives the shared secret, and NEVER stores private keys or secrets.
 *
 * Devices generate ephemeral keys and derive the shared secret locally (see
 * `client/src/lib/keyAgreement.js`). All routes sit behind the existing
 * `protectedRoute` (JWT); the caller's role (initiator/responder) is inferred from
 * the SHS handshake session, never trusted from the request body.
 *
 * @security No endpoint accepts or returns a private key or a shared secret. Only
 * public ephemeral keys + commitments + public DTOs cross this boundary.
 */

import { KeyAgreementManager } from "../shs/key-agreement/manager/keyAgreementManager.js";
import { createMongoKeyAgreementRepositories } from "../shs/key-agreement/repository/mongoRepository.js";
import { KeyAgreementError } from "../shs/key-agreement/errors.js";
import { cryptoCapabilities } from "../shs/key-agreement/negotiation/cryptoNegotiation.js";
import { KeyAgreementEventBus } from "../shs/key-agreement/events/keyAgreementEvents.js";
import { createMongoShsRepository } from "../shs/repository/mongoRepository.js";
import { ShsError } from "../shs/errors.js";
import { IdentityManager } from "../identity/manager/identityManager.js";
import { createMongoRepositories } from "../identity/repository/mongoRepository.js";
import { IdentityError } from "../identity/errors.js";

const identityManager = new IdentityManager(createMongoRepositories());
const { sessions } = createMongoShsRepository();

/** Shared event bus — future layers (session-key derivation) subscribe here. */
export const keyAgreementEvents = new KeyAgreementEventBus();

const keyAgreement = new KeyAgreementManager({
  ...createMongoKeyAgreementRepositories(),
  sessions,
  events: keyAgreementEvents,
  identityLookup: (userId) => identityManager.getIdentityByUser(userId),
});

export { keyAgreement };

function handleError(res, error, where) {
  if (error instanceof KeyAgreementError || error instanceof ShsError || error instanceof IdentityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

const callerId = (req) => String(req.user._id);

/**
 * Load the SHS session and resolve the caller's role within it.
 * @returns {Promise<{ session: object, role: "initiator"|"responder" } | { error: object }>}
 */
async function resolveParty(req, res) {
  const session = await sessions.findById(req.params.id);
  if (!session) {
    res.status(404).json({ success: false, code: "ERR_SHS_NOT_FOUND", message: "Handshake not found" });
    return null;
  }
  const me = callerId(req);
  const role = String(session.initiator) === me ? "initiator" : String(session.responder) === me ? "responder" : null;
  if (!role) {
    res.status(403).json({ success: false, code: "ERR_KA_UNKNOWN_PEER", message: "Not a party to this handshake" });
    return null;
  }
  return { session, role };
}

/** POST /api/key-agreement/:id/negotiate — Body: { initiatorOffer?, responderOffer? } */
export const negotiate = async (req, res) => {
  try {
    const party = await resolveParty(req, res);
    if (!party) return;
    const { initiatorOffer, responderOffer } = req.body ?? {};
    const exchange = await keyAgreement.negotiate(req.params.id, {
      initiator: String(party.session.initiator),
      responder: String(party.session.responder),
      initiatorOffer,
      responderOffer,
    });
    return res.status(201).json({ success: true, exchange });
  } catch (error) {
    return handleError(res, error, "negotiate");
  }
};

/**
 * POST /api/key-agreement/:id/keys — Body: { ephemeralKey } (a PUBLIC key bundle).
 * Serves both "Initiate Key Agreement" (initiator) and "Respond To Key Agreement"
 * (responder); the role is inferred from the session.
 */
export const submitKey = async (req, res) => {
  try {
    const party = await resolveParty(req, res);
    if (!party) return;
    const exchange = await keyAgreement.submitEphemeralKey(req.params.id, party.role, req.body?.ephemeralKey ?? {});
    return res.status(200).json({ success: true, exchange });
  } catch (error) {
    return handleError(res, error, "submitKey");
  }
};

/** GET /api/key-agreement/:id/peer-key — the peer's PUBLIC ephemeral key (to derive against). */
export const getPeerKey = async (req, res) => {
  try {
    const party = await resolveParty(req, res);
    if (!party) return;
    const peerKey = await keyAgreement.getPeerKey(req.params.id, party.role);
    return res.status(200).json({ success: true, peerKey });
  } catch (error) {
    return handleError(res, error, "getPeerKey");
  }
};

/** POST /api/key-agreement/:id/commitment — Body: { commitment } (one-way hash of the derived secret). */
export const submitCommitment = async (req, res) => {
  try {
    const party = await resolveParty(req, res);
    if (!party) return;
    const exchange = await keyAgreement.submitCommitment(req.params.id, party.role, req.body?.commitment);
    return res.status(200).json({ success: true, exchange });
  } catch (error) {
    return handleError(res, error, "submitCommitment");
  }
};

/** GET /api/key-agreement/:id — key-exchange status (PUBLIC; no secret). */
export const getExchange = async (req, res) => {
  try {
    const party = await resolveParty(req, res);
    if (!party) return;
    const exchange = await keyAgreement.getExchange(req.params.id);
    return res.status(200).json({ success: true, exchange });
  } catch (error) {
    return handleError(res, error, "getExchange");
  }
};

/**
 * GET /api/key-agreement/:id/material-status — the server's view of session material.
 * The server does NOT hold the shared secret; this reports whether the exchange is
 * established and whether both parties committed. The actual secret is device-local.
 */
export const getMaterialStatus = async (req, res) => {
  try {
    const party = await resolveParty(req, res);
    if (!party) return;
    const exchange = await keyAgreement.getExchange(req.params.id);
    return res.status(200).json({
      success: true,
      status: {
        handshakeId: exchange.handshakeId,
        established: exchange.state === "established",
        state: exchange.state,
        initiatorCommitted: exchange.initiatorCommitted,
        responderCommitted: exchange.responderCommitted,
        algorithm: exchange.algorithm,
        cryptoVersion: exchange.cryptoVersion,
        note: "The shared secret is derived and stored on-device; the server never sees it.",
      },
    });
  } catch (error) {
    return handleError(res, error, "getMaterialStatus");
  }
};

/** GET /api/key-agreement — list the caller's key exchanges (PUBLIC DTOs). */
export const listExchanges = async (req, res) => {
  try {
    const exchanges = await keyAgreement.listExchanges(callerId(req));
    return res.status(200).json({ success: true, exchanges });
  } catch (error) {
    return handleError(res, error, "listExchanges");
  }
};

/** GET /api/key-agreement/capabilities — advertised crypto algorithms + versions. */
export const getCapabilities = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, capabilities: cryptoCapabilities() });
  } catch (error) {
    return handleError(res, error, "getCapabilities");
  }
};
