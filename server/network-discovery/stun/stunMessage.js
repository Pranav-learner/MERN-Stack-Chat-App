/**
 * @module network-discovery/stun/stunMessage
 *
 * **STUN message codec** (RFC 5389) — the pure, dependency-free protocol layer. Encodes a Binding
 * Request and decodes a Binding Success Response's `MAPPED-ADDRESS` / `XOR-MAPPED-ADDRESS` to reveal
 * the public (server-reflexive) address a STUN server observed. No sockets here — the transport is
 * injected by {@link module:network-discovery/stun/stunClient}, so the codec is fully testable.
 *
 * @security STUN messages carry addressing metadata only. The transaction id is a random 96-bit
 * nonce (matching request↔response) — not a cryptographic secret.
 *
 * @networking Header (20 bytes): type(2) · length(2) · magic-cookie(4=0x2112A442) · txid(12). The
 * XOR-MAPPED-ADDRESS obfuscates the address by XOR-ing with the magic cookie (+ txid for IPv6) so
 * naive NATs don't rewrite it in the payload.
 */

import crypto from "node:crypto";
import { AddressFamily } from "../types/types.js";
import { StunProtocolError } from "../errors.js";

/** The STUN magic cookie. */
export const MAGIC_COOKIE = 0x2112a442;
const MAGIC_COOKIE_BUF = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

/** STUN message types. */
export const StunMessageType = Object.freeze({
  BINDING_REQUEST: 0x0001,
  BINDING_SUCCESS: 0x0101,
  BINDING_ERROR: 0x0111,
});

/** STUN attribute types. */
export const StunAttribute = Object.freeze({
  MAPPED_ADDRESS: 0x0001,
  XOR_MAPPED_ADDRESS: 0x0020,
  ERROR_CODE: 0x0009,
  SOFTWARE: 0x8022,
});

const FAMILY_IPV4 = 0x01;
const FAMILY_IPV6 = 0x02;

/**
 * Build a STUN Binding Request.
 * @param {Buffer} [transactionId] a 12-byte txid (random if omitted)
 * @returns {{ message: Buffer, transactionId: Buffer }}
 */
export function buildBindingRequest(transactionId) {
  const txid = transactionId ?? crypto.randomBytes(12);
  if (txid.length !== 12) throw new StunProtocolError("Transaction id must be 12 bytes");
  const msg = Buffer.alloc(20);
  msg.writeUInt16BE(StunMessageType.BINDING_REQUEST, 0);
  msg.writeUInt16BE(0, 2); // no attributes
  MAGIC_COOKIE_BUF.copy(msg, 4);
  txid.copy(msg, 8);
  return { message: msg, transactionId: txid };
}

/**
 * Parse a STUN message. Returns the type, transaction id, and any decoded mapped address.
 * @param {Buffer} buf @returns {{ type: number, transactionId: Buffer, mappedAddress: {family:string,ip:string,port:number}|null, isSuccess: boolean }}
 * @throws {StunProtocolError}
 */
export function parseStunMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) throw new StunProtocolError("STUN message too short");
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  if (buf.readUInt32BE(4) !== MAGIC_COOKIE) throw new StunProtocolError("Bad STUN magic cookie");
  const transactionId = buf.subarray(8, 20);
  if (20 + length > buf.length) throw new StunProtocolError("STUN length exceeds buffer");

  let mappedAddress = null;
  let offset = 20;
  const end = 20 + length;
  while (offset + 4 <= end) {
    const attrType = buf.readUInt16BE(offset);
    const attrLen = buf.readUInt16BE(offset + 2);
    const valStart = offset + 4;
    if (valStart + attrLen > buf.length) break;
    const value = buf.subarray(valStart, valStart + attrLen);
    if (attrType === StunAttribute.XOR_MAPPED_ADDRESS) mappedAddress = decodeXorMappedAddress(value, transactionId);
    else if (attrType === StunAttribute.MAPPED_ADDRESS && !mappedAddress) mappedAddress = decodeMappedAddress(value);
    offset = valStart + attrLen + ((4 - (attrLen % 4)) % 4); // 4-byte padding
  }
  return { type, transactionId, mappedAddress, isSuccess: type === StunMessageType.BINDING_SUCCESS };
}

/**
 * Encode a Binding Success Response with an XOR-MAPPED-ADDRESS (used by mock STUN transports + tests
 * to synthesize a server's reply). @param {Buffer} transactionId @param {{ip:string,port:number,family?:string}} addr
 * @returns {Buffer}
 */
export function encodeBindingResponse(transactionId, addr) {
  const family = addr.family === AddressFamily.IPV6 ? FAMILY_IPV6 : FAMILY_IPV4;
  const addrBytes = family === FAMILY_IPV6 ? ipv6ToBytes(addr.ip) : ipv4ToBytes(addr.ip);
  const value = Buffer.alloc(4 + addrBytes.length);
  value[0] = 0;
  value[1] = family;
  value.writeUInt16BE(addr.port ^ (MAGIC_COOKIE >>> 16), 2);
  const mask = xorMask(family, transactionId);
  for (let i = 0; i < addrBytes.length; i++) value[4 + i] = addrBytes[i] ^ mask[i];

  const attrLen = value.length;
  const attr = Buffer.alloc(4 + attrLen);
  attr.writeUInt16BE(StunAttribute.XOR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(attrLen, 2);
  value.copy(attr, 4);

  const msg = Buffer.alloc(20 + attr.length);
  msg.writeUInt16BE(StunMessageType.BINDING_SUCCESS, 0);
  msg.writeUInt16BE(attr.length, 2);
  MAGIC_COOKIE_BUF.copy(msg, 4);
  transactionId.copy(msg, 8);
  attr.copy(msg, 20);
  return msg;
}

// === internals ============================================================

function decodeMappedAddress(value) {
  const family = value[1] === FAMILY_IPV6 ? AddressFamily.IPV6 : AddressFamily.IPV4;
  const port = value.readUInt16BE(2);
  const ip = family === AddressFamily.IPV6 ? bytesToIpv6(value.subarray(4, 20)) : bytesToIpv4(value.subarray(4, 8));
  return { family, ip, port };
}

function decodeXorMappedAddress(value, transactionId) {
  const fam = value[1];
  const family = fam === FAMILY_IPV6 ? AddressFamily.IPV6 : AddressFamily.IPV4;
  const port = value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const mask = xorMask(fam, transactionId);
  const n = fam === FAMILY_IPV6 ? 16 : 4;
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i++) bytes[i] = value[4 + i] ^ mask[i];
  const ip = family === AddressFamily.IPV6 ? bytesToIpv6(bytes) : bytesToIpv4(bytes);
  return { family, ip, port };
}

/** The XOR mask: magic cookie for IPv4; magic cookie || txid for IPv6. */
function xorMask(family, transactionId) {
  if (family === FAMILY_IPV6) return Buffer.concat([MAGIC_COOKIE_BUF, transactionId]);
  return MAGIC_COOKIE_BUF;
}

function ipv4ToBytes(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new StunProtocolError(`Invalid IPv4: ${ip}`);
  return Buffer.from(parts);
}

function bytesToIpv4(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/** Parse an IPv6 string (with `::` compression) into 16 bytes. */
function ipv6ToBytes(ip) {
  const s = String(ip);
  const [head, tail] = s.split("::");
  const parse = (part) => (part ? part.split(":").filter((x) => x !== "") : []);
  const h = parse(head);
  const t = tail !== undefined ? parse(tail) : [];
  const missing = 8 - (h.length + t.length);
  if (missing < 0) throw new StunProtocolError(`Invalid IPv6: ${ip}`);
  const groups = [...h, ...Array(tail !== undefined ? missing : 0).fill("0"), ...t];
  if (groups.length !== 8) throw new StunProtocolError(`Invalid IPv6: ${ip}`);
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || "0", 16) & 0xffff, i * 2));
  return out;
}

/** Render 16 bytes as a compressed IPv6 string. */
function bytesToIpv6(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  // Compress the longest run of zeros.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  groups.forEach((g, i) => {
    if (g === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else { curStart = -1; curLen = 0; }
  });
  if (bestLen > 1) {
    const before = groups.slice(0, bestStart).join(":");
    const after = groups.slice(bestStart + bestLen).join(":");
    return `${before}::${after}`;
  }
  return groups.join(":");
}
