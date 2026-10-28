import dns from "node:dns";
import net from "node:net";

// Decides which network destinations the server may call on a tenant's behalf (webhooks). Three classes:
//   denied  - never reachable, not even by allow-list: link-local (cloud metadata), unspecified, multicast, reserved, known metadata addresses.
//   private - loopback, RFC 1918, CGNAT, ULA, documentation and other non-global ranges: blocked unless inside WEBHOOK_ALLOWED_CIDRS.
//   public  - everything else (global unicast).
// IPv6 forms that embed an IPv4 address (v4-mapped, NAT64, 6to4) are judged by the address they embed.

const DENIED_V4 = [["0.0.0.0", 8], ["169.254.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4], ["100.100.100.200", 32], ["192.0.0.192", 32]];
const PRIVATE_V4 = [["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24]];
const DENIED_V6 = [["fe80::", 10], ["ff00::", 8], ["fd00:ec2::254", 128]];

const list = (entries, family) => { const blocks = new net.BlockList(); for (const [address, prefix] of entries) blocks.addSubnet(address, prefix, family); return blocks; };
const deniedV4 = list(DENIED_V4, "ipv4"); const privateV4 = list(PRIVATE_V4, "ipv4"); const deniedV6 = list(DENIED_V6, "ipv6");

// Global unicast IPv6 is 2000::/3; the documentation, ORCHID and Teredo blocks inside it are not routable on the public internet.
const globalV6 = list([["2000::", 3]], "ipv6");
const nonGlobalInsideV6 = list([["2001::", 32], ["2001:2::", 48], ["2001:10::", 28], ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 8]], "ipv6");

// The 16 bytes of an IPv6 address (net.isIP has already vouched for its syntax).
function v6Bytes(address) {
  let text = address.split("%")[0].toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { const octets = tail[1].split(".").map(Number); text = text.slice(0, -tail[1].length) + ((octets[0] << 8) | octets[1]).toString(16) + ":" + ((octets[2] << 8) | octets[3]).toString(16); }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : []; const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group || "0", 16), index * 2));
  return bytes;
}
const v4Text = (bytes) => `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;

// Returns "denied", "private" or "public" for an IP literal; anything that is not an IP is "denied".
export function classify(address) {
  const family = net.isIP(address);
  if (family === 4) {
    if (deniedV4.check(address, "ipv4")) return "denied";
    return privateV4.check(address, "ipv4") ? "private" : "public";
  }
  if (family !== 6) return "denied";
  const bytes = v6Bytes(address);
  const is = (prefix) => prefix.every((byte, index) => bytes[index] === byte);
  // ::ffff:a.b.c.d (v4-mapped) and 64:ff9b::a.b.c.d (NAT64) carry an IPv4 address in the last 4 bytes; 2002:aabb:ccdd:: (6to4) in bytes 2-5.
  if (is([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]) || is([0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return classify(v4Text(bytes.subarray(12)));
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return classify(v4Text(bytes.subarray(2)));
  const normalized = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(":");
  if (deniedV6.check(normalized, "ipv6")) return "denied";
  // Unspecified, loopback and the deprecated IPv4-compatible block (::/96) are all inside ::/96.
  if (is([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) return bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 0 ? "denied" : "private";
  if (!globalV6.check(normalized, "ipv6") || nonGlobalInsideV6.check(normalized, "ipv6")) return "private";
  return "public";
}

// "10.0.0.0/8" or "fd00::/8" (a bare address means a single host). Throws on anything else.
export function parseCidr(text) {
  const [address, prefixText, ...extra] = String(text).trim().split("/");
  const family = net.isIP(address);
  if (!family || extra.length || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) throw new Error(`"${text}" is not an address or CIDR range`);
  const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) throw new Error(`"${text}" has a prefix that is too long`);
  return { address, prefix, family: family === 4 ? "ipv4" : "ipv6" };
}

export function createGuard({ allowedCidrs = [], allowAll = false } = {}) {
  const allowed = new net.BlockList();
  for (const cidr of allowedCidrs) { const parsed = parseCidr(cidr); allowed.addSubnet(parsed.address, parsed.prefix, parsed.family); }
  const allowedHas = (address) => {
    if (allowed.check(address, net.isIP(address) === 4 ? "ipv4" : "ipv6")) return true;
    // An allow-list entry for an IPv4 range also covers that range reached through a v4-mapped IPv6 address.
    const mapped = net.isIP(address) === 6 ? classifyEmbedded(address) : null;
    return mapped ? allowed.check(mapped, "ipv4") : false;
  };
  return {
    // "ok" | "denied" | "not_allowed" for one resolved address.
    verdict(address) {
      if (allowAll) return "ok";
      const kind = classify(address);
      if (kind === "denied") return "denied";
      if (kind === "private") return allowedHas(address) ? "ok" : "not_allowed";
      return "ok";
    },
    // True when the address is inside an explicitly allowed range (plain http is only acceptable there).
    isAllowListed: (address) => allowAll || allowedHas(address)
  };
}

// The IPv4 address inside a v4-mapped/NAT64 address, or null.
function classifyEmbedded(address) {
  const bytes = v6Bytes(address);
  const mapped = bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 = bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.subarray(4, 12).every((byte) => byte === 0);
  return mapped || nat64 ? v4Text(bytes.subarray(12)) : null;
}

export class BlockedDestination extends Error {
  constructor(reason) { super(reason); this.code = "destination_blocked"; this.reason = reason; }
}

// Resolves a host once and vets every answer: one bad address among several rejects the lot (no choosing the good one), so a
// rebinding attacker cannot mix a public and an internal record. The caller connects to the returned address, never to the name again.
export async function resolveSafe(hostname, guard, { lookup = dns.promises.lookup } = {}) {
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const answers = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!answers.length) throw new BlockedDestination("no_address");
  for (const { address } of answers) {
    const verdict = guard.verdict(address);
    if (verdict !== "ok") throw new BlockedDestination(verdict === "denied" ? "address_denied" : "address_not_allowed");
  }
  return answers[0];
}
