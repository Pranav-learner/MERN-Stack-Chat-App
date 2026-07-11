/**
 * @module network-discovery/interfaces
 *
 * **Local network interface detection.** Enumerates a device's network interfaces + their
 * addresses — the source of HOST candidates. The provider is INJECTABLE so the manager runs in Node
 * (real `os.networkInterfaces()`), in the browser (the app supplies WebRTC/host-gathered addresses),
 * or under test (a static list).
 *
 * @security Interface descriptors are PUBLIC addressing metadata — names, IPs, families, MACs. No
 * key material. (An IP is sensitive but not a cryptographic secret.)
 *
 * @networking Loopback/internal interfaces are excluded from candidates by default (you can't
 * connect a peer to `127.0.0.1`), but are still reported in diagnostics. Link-local IPv6
 * (`fe80::/10`) is flagged so ICE can decide whether to use it.
 */

import os from "node:os";
import { AddressFamily } from "../types/types.js";

/** Whether an IPv4 address is in a private RFC 1918 range. */
export function isPrivateIPv4(ip) {
  if (typeof ip !== "string") return false;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
}

/** Whether an address is loopback. */
export function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || (typeof ip === "string" && ip.startsWith("127."));
}

/** Whether an IPv6 address is link-local (`fe80::/10`). */
export function isLinkLocalIPv6(ip) {
  return typeof ip === "string" && /^fe[89ab]/i.test(ip);
}

/** Normalize a node `family` value ("IPv4"/"IPv6" or 4/6) to {@link AddressFamily}. */
function normalizeFamily(family) {
  if (family === "IPv6" || family === 6 || family === "6") return AddressFamily.IPV6;
  return AddressFamily.IPV4;
}

/**
 * Normalize raw interface data (node's `os.networkInterfaces()` shape OR a flat array) into a list
 * of {@link NetworkInterfaceDescriptor}. De-duplicates by (name, address).
 * @param {object|Array} raw @returns {import("../types/types.js").NetworkInterfaceDescriptor[]}
 */
export function normalizeInterfaces(raw) {
  const out = [];
  const seen = new Set();
  const push = (name, addr) => {
    if (!addr || !addr.address) return;
    const family = normalizeFamily(addr.family);
    const key = `${name}|${addr.address}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: String(name),
      family,
      address: addr.address,
      internal: !!addr.internal || isLoopback(addr.address),
      ...(addr.mac ? { mac: addr.mac } : {}),
      ...(addr.scopeid !== undefined ? { scopeid: addr.scopeid } : {}),
      // Preserve a caller-supplied bound port (device-reported / socket-bound) — OS interfaces have
      // none, but the browser/agent supplies it so it can flow into host candidates.
      ...(Number.isInteger(addr.port) ? { port: addr.port } : {}),
      ...(isLinkLocalIPv6(addr.address) ? { linkLocal: true } : {}),
    });
  };
  if (Array.isArray(raw)) {
    for (const addr of raw) push(addr.name ?? "iface", addr);
  } else if (raw && typeof raw === "object") {
    for (const [name, addrs] of Object.entries(raw)) for (const addr of addrs ?? []) push(name, addr);
  }
  return out;
}

/** The subset of interfaces usable as HOST candidates (non-internal, non-link-local by default). */
export function usableInterfaces(interfaces, options = {}) {
  return (interfaces ?? []).filter((i) => !i.internal && (options.includeLinkLocal || !i.linkLocal));
}

/**
 * A Node interface provider backed by `os.networkInterfaces()`.
 * @returns {{ list: () => Promise<import("../types/types.js").NetworkInterfaceDescriptor[]> }}
 */
export function createNodeInterfaceProvider() {
  return {
    async list() {
      return normalizeInterfaces(os.networkInterfaces());
    },
  };
}

/**
 * A static interface provider (tests / device-reported data / browser-supplied host addresses).
 * @param {object|Array} interfaces @returns {{ list: () => Promise<object[]> }}
 */
export function createStaticInterfaceProvider(interfaces) {
  const normalized = normalizeInterfaces(interfaces);
  return {
    async list() {
      return normalized.map((i) => ({ ...i }));
    },
  };
}

/** Whether an object satisfies the interface-provider contract. */
export function isInterfaceProvider(provider) {
  return !!provider && typeof provider.list === "function";
}
