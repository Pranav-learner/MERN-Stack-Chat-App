/**
 * @module controllers/networkDiscoveryController
 *
 * HTTP handlers for the **Network Discovery** subsystem (Layer 7, Sprint 1), mounted at
 * `/api/network-discovery`. Devices discover their OWN network environment: the browser/agent
 * gathers interfaces + STUN results (or candidates via WebRTC) and REPORTS them here; the server
 * validates, classifies NAT, gathers/normalizes candidates, and stores the resulting Network
 * Profile. The server can also run STUN itself (Node UDP transport) for server-side/agent scenarios.
 *
 * This sprint discovers + gathers ONLY. It performs NO ICE connectivity checks, NO candidate-pair
 * selection, NO TURN relay, and opens NO peer socket. Every route is JWT-protected; the
 * authenticated `req.user._id` is the profile owner.
 *
 * @security Returns PUBLIC network addressing metadata only — never key material.
 */

import { NetworkDiscoveryManager } from "../network-discovery/manager/networkDiscoveryManager.js";
import { createDiscoveryApi } from "../network-discovery/api/discoveryApi.js";
import { createMongoDiscoveryRepository } from "../network-discovery/repository/mongoDiscoveryRepository.js";
import { StunClient } from "../network-discovery/stun/stunClient.js";
import { createNodeUdpStunTransport } from "../network-discovery/stun/nodeUdpTransport.js";
import { createNodeInterfaceProvider } from "../network-discovery/interfaces/interfaces.js";
import { DiscoveryEventBus } from "../network-discovery/events/events.js";
import { DiscoveryError } from "../network-discovery/errors.js";
import { DEFAULT_STUN_SERVERS } from "../network-discovery/types/types.js";

/** Shared network-discovery event bus. Future ICE (Sprint 2) subscribes here. */
export const networkDiscoveryEvents = new DiscoveryEventBus();

/**
 * Process-wide Network Discovery Manager. The interface provider + STUN client back the OPTIONAL
 * server-run discovery path; the primary flow is device-reported (interfaces/candidates in the body).
 */
export const networkDiscoveryManager = new NetworkDiscoveryManager({
  ...createMongoDiscoveryRepository(),
  interfaceProvider: createNodeInterfaceProvider(),
  stunClient: new StunClient({ transport: createNodeUdpStunTransport(), servers: DEFAULT_STUN_SERVERS }),
  stunServers: DEFAULT_STUN_SERVERS,
  events: networkDiscoveryEvents,
});

/** The stable, transport-independent facade the HTTP handlers delegate to. */
export const networkDiscoveryApi = createDiscoveryApi(networkDiscoveryManager);

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof DiscoveryError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/network-discovery/generate — generate the caller's device network profile.
 * Body: { deviceId, interfaces?, stunResults?, candidates?, stunServers?, ttlMs? }.
 */
export const generate = async (req, res) => {
  try {
    const profile = await networkDiscoveryApi.generate({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, profile });
  } catch (error) {
    return handleError(res, error, "generate");
  }
};

/** POST /api/network-discovery/refresh — refresh the caller's device network profile. Body: { deviceId, ... }. */
export const refresh = async (req, res) => {
  try {
    const profile = await networkDiscoveryApi.refresh({ actingUser: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, profile });
  } catch (error) {
    return handleError(res, error, "refresh");
  }
};

/** GET /api/network-discovery/profile/:profileId — a network profile by id. */
export const getProfile = async (req, res) => {
  try {
    const profile = await networkDiscoveryApi.getProfile({ actingUser: callerId(req), profileId: req.params.profileId, includeCandidates: req.query.candidates !== "false" });
    return res.status(200).json({ success: true, profile });
  } catch (error) {
    return handleError(res, error, "getProfile");
  }
};

/** GET /api/network-discovery/device/:deviceId — the caller's current profile for a device. */
export const getCurrent = async (req, res) => {
  try {
    const profile = await networkDiscoveryApi.getCurrent({ actingUser: callerId(req), deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, profile });
  } catch (error) {
    return handleError(res, error, "getCurrent");
  }
};

/** GET /api/network-discovery/device/:deviceId/candidates — the device's non-expired candidates. */
export const getCandidates = async (req, res) => {
  try {
    const candidates = await networkDiscoveryApi.getCandidates({ actingUser: callerId(req), deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, candidates });
  } catch (error) {
    return handleError(res, error, "getCandidates");
  }
};

/** GET /api/network-discovery/device/:deviceId/interfaces — the device's interfaces. */
export const getInterfaces = async (req, res) => {
  try {
    const interfaces = await networkDiscoveryApi.listInterfaces({ actingUser: callerId(req), deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, interfaces });
  } catch (error) {
    return handleError(res, error, "getInterfaces");
  }
};

/** GET /api/network-discovery/device/:deviceId/public-address — the device's public address. */
export const getPublicAddress = async (req, res) => {
  try {
    const publicAddress = await networkDiscoveryApi.getPublicAddress({ actingUser: callerId(req), deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, publicAddress });
  } catch (error) {
    return handleError(res, error, "getPublicAddress");
  }
};

/** GET /api/network-discovery/device/:deviceId/nat — the device's NAT info. */
export const getNat = async (req, res) => {
  try {
    const nat = await networkDiscoveryApi.getNatInfo({ actingUser: callerId(req), deviceId: req.params.deviceId });
    return res.status(200).json({ success: true, nat });
  } catch (error) {
    return handleError(res, error, "getNat");
  }
};

/** GET /api/network-discovery/device/:deviceId/diagnostics — discovery diagnostics + history. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await networkDiscoveryApi.getDiagnostics({ actingUser: callerId(req), deviceId: req.params.deviceId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};
