import test from "node:test";
import assert from "node:assert/strict";
import { BlockedDestination, classify, createGuard, parseCidr, resolveSafe } from "../src/netguard.mjs";

const strict = createGuard();
const kind = (address) => classify(address);

test("IPv4: public addresses are allowed, everything non-global is not (including the range edges)", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "11.0.0.1", "192.169.0.1", "223.255.255.255"]) assert.equal(kind(address), "public", address);
  for (const address of ["127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255", "192.0.2.1", "198.51.100.7", "203.0.113.9", "192.0.0.1"]) assert.equal(kind(address), "private", address);
  for (const address of ["0.0.0.0", "0.1.2.3", "169.254.169.254", "169.254.0.1", "169.254.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "100.100.100.200", "192.0.0.192"]) assert.equal(kind(address), "denied", address);
});

test("IPv6: only global unicast is public; loopback, ULA, documentation and friends are not", () => {
  for (const address of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888"]) assert.equal(kind(address), "public", address);
  for (const address of ["::1", "fc00::1", "fd12:3456::1", "2001:db8::1", "2001::1", "64:ff9b:1::1", "100::1", "::2", "::7f00:1", "5f00::1", "3fff::1"]) assert.equal(kind(address), "private", address);
  for (const address of ["::", "fe80::1", "febf::1", "ff02::1", "ff0e::1", "fd00:ec2::254", "FD00:EC2:0:0:0:0:0:254"]) assert.equal(kind(address), "denied", address);
});

test("addresses that embed an IPv4 address are judged by the embedded address, in every spelling", () => {
  const cases = {
    private: ["::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:7F00:1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:c0a8:101", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::1", "2002:0a00:0001::1"],
    denied: ["::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:0.0.0.0", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "::ffff:224.0.0.1"],
    public: ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]
  };
  for (const [expected, addresses] of Object.entries(cases)) for (const address of addresses) assert.equal(kind(address), expected, address);
});

test("anything that is not an IP literal is never trusted", () => {
  for (const value of ["localhost", "example.com", "", "1.2.3", "1.2.3.4.5", "0x7f.0.0.1", "2130706433", "::g", "[::1]"]) assert.equal(kind(value), "denied", JSON.stringify(value));
});

test("the guard: public passes, private needs the allow-list, denied never passes", () => {
  assert.equal(strict.verdict("8.8.8.8"), "ok");
  assert.equal(strict.verdict("127.0.0.1"), "not_allowed");
  assert.equal(strict.verdict("10.0.0.5"), "not_allowed");
  assert.equal(strict.verdict("169.254.169.254"), "denied");
  assert.equal(strict.verdict("::1"), "not_allowed");
  assert.equal(strict.verdict("::ffff:169.254.169.254"), "denied");

  const internal = createGuard({ allowedCidrs: ["10.0.0.0/8", "fd00::/8", "192.168.1.7"] });
  assert.equal(internal.verdict("10.1.2.3"), "ok"); assert.equal(internal.verdict("fd12::1"), "ok"); assert.equal(internal.verdict("192.168.1.7"), "ok");
  assert.equal(internal.verdict("192.168.1.8"), "not_allowed", "a single-host entry covers that host only");
  assert.equal(internal.verdict("172.16.0.1"), "not_allowed"); assert.equal(internal.verdict("127.0.0.1"), "not_allowed");
  assert.equal(internal.verdict("::ffff:10.1.2.3"), "ok", "an IPv4 entry also covers the v4-mapped spelling");
  assert.equal(internal.verdict("::ffff:172.16.0.1"), "not_allowed");
  assert.equal(internal.isAllowListed("10.1.2.3"), true); assert.equal(internal.isAllowListed("8.8.8.8"), false);

  // No allow-list entry, however wide, unlocks link-local, metadata or reserved space.
  const everything = createGuard({ allowedCidrs: ["0.0.0.0/0", "::/0", "169.254.0.0/16", "fd00::/8"] });
  for (const address of ["169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "100.100.100.200", "fd00:ec2::254", "fe80::1", "::", "::ffff:169.254.169.254"]) assert.equal(everything.verdict(address), "denied", address);
  assert.equal(everything.verdict("127.0.0.1"), "ok", "loopback is an operator decision");

  // The development switch is the only way past the deny list.
  assert.equal(createGuard({ allowAll: true }).verdict("169.254.169.254"), "ok");
});

test("CIDR parsing is strict", () => {
  assert.deepEqual(parseCidr("10.0.0.0/8"), { address: "10.0.0.0", prefix: 8, family: "ipv4" });
  assert.deepEqual(parseCidr(" fd00::/8 "), { address: "fd00::", prefix: 8, family: "ipv6" });
  assert.deepEqual(parseCidr("192.168.1.7"), { address: "192.168.1.7", prefix: 32, family: "ipv4" });
  for (const bad of ["10.0.0.0/33", "foo", "10.0.0.0/8/8", "1.2.3.4/", "::/129", "10.0.0.0/-1", "10.0.0.0/x", "", "localhost/8"]) assert.throws(() => parseCidr(bad), undefined, JSON.stringify(bad));
  assert.throws(() => createGuard({ allowedCidrs: ["nonsense"] }));
});

test("name resolution: every answer is vetted, so a mixed record set cannot smuggle an internal address through", async () => {
  const answers = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  assert.deepEqual(await resolveSafe("hooks.example.com", strict, { lookup: answers("8.8.8.8", "1.1.1.1") }), { address: "8.8.8.8", family: 4 });
  for (const [lookup, reason] of [
    [answers("8.8.8.8", "10.0.0.1"), "address_not_allowed"], [answers("10.0.0.1", "8.8.8.8"), "address_not_allowed"],
    [answers("169.254.169.254"), "address_denied"], [answers("127.0.0.1"), "address_not_allowed"], [answers("::ffff:127.0.0.1"), "address_not_allowed"],
    [answers("2606:4700:4700::1111", "::1"), "address_not_allowed"], [answers(), "no_address"]
  ]) {
    await assert.rejects(resolveSafe("hooks.example.com", strict, { lookup }), (error) => error instanceof BlockedDestination && error.reason === reason && error.code === "destination_blocked", reason);
  }
  // IP literals skip DNS entirely and are judged directly (bracketed IPv6 included).
  const never = async () => { throw new Error("DNS must not be consulted for an IP literal"); };
  assert.deepEqual(await resolveSafe("93.184.216.34", strict, { lookup: never }), { address: "93.184.216.34", family: 4 });
  await assert.rejects(resolveSafe("127.0.0.1", strict, { lookup: never }), BlockedDestination);
  await assert.rejects(resolveSafe("[::1]", strict, { lookup: never }), BlockedDestination);
  await assert.rejects(resolveSafe("[::ffff:7f00:1]", strict, { lookup: never }), BlockedDestination);
  assert.deepEqual(await resolveSafe("10.1.2.3", createGuard({ allowedCidrs: ["10.0.0.0/8"] }), { lookup: never }), { address: "10.1.2.3", family: 4 });
  // A failing resolver is a resolution failure, not a pass.
  await assert.rejects(resolveSafe("nx.example.com", strict, { lookup: async () => { throw Object.assign(new Error("nope"), { code: "ENOTFOUND" }); } }), (error) => error.code === "ENOTFOUND");
});
