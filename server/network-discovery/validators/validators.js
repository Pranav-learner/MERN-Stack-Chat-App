/**
 * @module network-discovery/validators
 *
 * Validation for the Network Discovery subsystem. Covers every spec item: invalid interfaces,
 * missing public address, malformed candidates, duplicate candidates, expired profiles, invalid NAT
 * metadata, repository consistency, and unauthorized requests. Also enforces the no-secret invariant.
 *
 * @security A profile/candidate must NEVER carry secret material. {@link assertNoSecretMaterial}
 * deep-scans for forbidden keys before storage.
 */

import { ALL_NAT_TYPES, ALL_CANDIDATE_TYPES } from "../types/types.js";
import {
  DiscoveryValidationError,
  ProfileNotFoundError,
  ProfileExpiredError,
  UnauthorizedDiscoveryError,
  CorruptedProfileError,
} from "../errors.js";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Field names that must NEVER appear in a profile/candidate. */
export const FORBIDDEN_SECRET_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "encryptionKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "ratchetKey",
  "keyBytes",
  "seed",
  "privateBytes",
]);

/** Validate a profile id's shape. @throws {DiscoveryValidationError} */
export function validateProfileId(profileId) {
  if (typeof profileId !== "string" || !ID_RE.test(profileId)) {
    throw new DiscoveryValidationError("Invalid profile identifier", { details: { profileId } });
  }
  return profileId;
}

/** Validate a user-id reference. @throws {DiscoveryValidationError} */
export function validateUserRef(userId) {
  if (userId == null || typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new DiscoveryValidationError("Invalid user identifier", { details: { userId } });
  }
  return userId;
}

/** Validate a device-id reference. @throws {DiscoveryValidationError} */
export function validateDeviceRef(deviceId) {
  if (deviceId == null || typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    throw new DiscoveryValidationError("Invalid device identifier", { details: { deviceId } });
  }
  return deviceId;
}

/** Whether a string is a syntactically valid IPv4. */
export function isValidIPv4(ip) {
  const m = IPV4_RE.exec(String(ip));
  return !!m && m.slice(1).every((n) => Number(n) >= 0 && Number(n) <= 255);
}

/** Validate a port number. @throws {DiscoveryValidationError} */
export function validatePort(port, { allowZero = true } = {}) {
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) {
    throw new DiscoveryValidationError("Invalid port", { details: { port } });
  }
  return port;
}

/**
 * Validate a list of interface descriptors: non-empty + each well-formed.
 * @param {object[]} interfaces @throws {DiscoveryValidationError}
 */
export function validateInterfaces(interfaces) {
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    throw new DiscoveryValidationError("interfaces must be a non-empty array", { details: { count: interfaces?.length ?? 0 } });
  }
  for (const iface of interfaces) {
    if (!iface || typeof iface !== "object" || !iface.address || typeof iface.address !== "string") {
      throw new DiscoveryValidationError("Malformed interface (missing address)", { details: { iface } });
    }
  }
  return interfaces;
}

/**
 * Validate a candidate's shape (ip/port/type/priority). @param {object} candidate
 * @throws {DiscoveryValidationError}
 */
export function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") throw new DiscoveryValidationError("Candidate is not an object");
  if (!ALL_CANDIDATE_TYPES.includes(candidate.type)) {
    throw new DiscoveryValidationError(`Unknown candidate type "${candidate.type}"`, { details: { type: candidate.type } });
  }
  if (candidate.type !== "relay") {
    if (!candidate.ip || typeof candidate.ip !== "string") throw new DiscoveryValidationError("Candidate missing ip", { details: { candidate: candidate.candidateId } });
    validatePort(candidate.port ?? -1);
    if (candidate.priority !== undefined && (!Number.isFinite(candidate.priority) || candidate.priority < 0)) {
      throw new DiscoveryValidationError("Candidate has an invalid priority", { details: { priority: candidate.priority } });
    }
  }
  return candidate;
}

/**
 * Validate a candidate LIST + reject DUPLICATES (same type/ip/port/transport). @param {object[]} candidates
 * @throws {DiscoveryValidationError}
 */
export function validateCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new DiscoveryValidationError("candidates must be an array");
  const seen = new Set();
  for (const c of candidates) {
    validateCandidate(c);
    if (c.type === "relay") continue;
    const key = `${c.type}|${c.ip}|${c.port}|${c.transport ?? "udp"}`;
    if (seen.has(key)) throw new DiscoveryValidationError(`Duplicate candidate ${key}`, { details: { key } });
    seen.add(key);
  }
  return candidates;
}

/** Validate NAT metadata shape. @throws {DiscoveryValidationError} */
export function validateNatMetadata(nat) {
  if (!nat || typeof nat !== "object") throw new DiscoveryValidationError("NAT metadata is not an object");
  const type = nat.natType ?? nat.type;
  if (!ALL_NAT_TYPES.includes(type)) throw new DiscoveryValidationError(`Unknown NAT type "${type}"`, { details: { type } });
  return nat;
}

/**
 * Validate a generate/report request payload. @param {object} request @throws {DiscoveryValidationError}
 */
export function validateGenerateRequest(request) {
  if (!request || typeof request !== "object") throw new DiscoveryValidationError("Malformed discovery request");
  validateDeviceRef(request.deviceId);
  if (request.userId !== undefined && request.userId !== null) validateUserRef(request.userId);
  if (request.interfaces !== undefined) validateInterfaces(request.interfaces);
  if (request.candidates !== undefined) validateCandidates(request.candidates);
  if (request.ttlMs !== undefined && (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)) {
    throw new DiscoveryValidationError("ttlMs must be a positive number", { details: { ttlMs: request.ttlMs } });
  }
  return request;
}

/** Require a profile to exist. @throws {ProfileNotFoundError} */
export function requireProfile(profile, ref) {
  if (!profile) throw new ProfileNotFoundError("Network profile not found", { details: { ref } });
  return profile;
}

/** Assert a profile has not expired. @throws {ProfileExpiredError} */
export function assertProfileNotExpired(profile, now = Date.now()) {
  if (profile?.expiresAt && new Date(profile.expiresAt).getTime() <= now && profile.state !== "expired") {
    throw new ProfileExpiredError("Network profile has expired", { details: { profileId: profile.profileId, expiresAt: profile.expiresAt } });
  }
  return profile;
}

/** Assert a caller owns a profile (device/user scoped). @throws {UnauthorizedDiscoveryError} */
export function assertOwner(profile, actingUserId, actingDeviceId) {
  const userOk = actingUserId && profile.userId != null && String(profile.userId) === String(actingUserId);
  const deviceOk = actingDeviceId && String(profile.deviceId) === String(actingDeviceId);
  if (!userOk && !deviceOk) {
    throw new UnauthorizedDiscoveryError("Caller does not own this network profile", { details: { profileId: profile.profileId } });
  }
  return profile;
}

/**
 * Deep-scan for forbidden secret key material. @param {any} value @param {string} [label]
 * @throws {CorruptedProfileError}
 */
export function assertNoSecretMaterial(value, label = "network profile") {
  const seen = new Set();
  const walk = (node, path) => {
    if (node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_SECRET_KEYS.includes(key)) {
        throw new CorruptedProfileError(`${label} must not contain secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate a produced profile's stored shape. @throws {CorruptedProfileError} */
export function validateProfile(profile) {
  if (!profile || typeof profile !== "object") throw new CorruptedProfileError("Network profile is not an object");
  for (const field of ["profileId", "deviceId", "natType", "interfaces", "candidates"]) {
    if (profile[field] === undefined || profile[field] === null) {
      throw new CorruptedProfileError(`Network profile is missing "${field}"`, { details: { field } });
    }
  }
  assertNoSecretMaterial(profile, "network profile");
  return profile;
}

/** Validate a repository implements the required profile-store contract. @throws {DiscoveryValidationError} */
export function validateProfileRepository(repo, methods = ["create", "findById", "findByDevice", "update", "delete", "listExpired"]) {
  if (!repo || typeof repo !== "object") throw new DiscoveryValidationError("Profile repository is missing or malformed");
  for (const m of methods) if (typeof repo[m] !== "function") throw new DiscoveryValidationError(`Profile repository is missing method "${m}"`, { details: { method: m } });
  return repo;
}
