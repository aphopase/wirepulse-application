// The failure limiter's window, on a mocked clock (the integration tests cannot wait a minute).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiters, ipKey } from "../src/ratelimit.mjs";

const noop = () => {};
function limiters(limit) {
  const counter = { inc: noop };
  return createRateLimiters({ config: { redis: null, limits: { authFailurePerMinute: limit, ipPerMinute: 1000, subjectPerMinute: 1000, gatewayPerMinute: 1000 } }, metrics: { rateLimited: counter, rateLimitStoreErrors: counter }, log: { warn: noop, info: noop } });
}
// Runs the middleware for one request from `ip`; resolves with the status it answered, or "next" when it let the request through.
const attempt = (limiter, ip = "203.0.113.9") => new Promise((resolve) => {
  const headers = {};
  const res = { set: (name, value) => { headers[name] = value; return res; }, status: (code) => ({ json: () => resolve({ status: code, headers }) }) };
  limiter({ ip, log: { warn: noop } }, res, () => resolve({ status: "next", headers }));
});

test("an address that used its failure budget is let back in when the window ends", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const rate = limiters(3);
  try {
    for (let i = 0; i < 3; i += 1) { assert.equal((await attempt(rate.authFailure)).status, "next"); await rate.authFailure.record({ ip: "203.0.113.9" }); }
    const refused = await attempt(rate.authFailure);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers["Retry-After"], "60");
    assert.equal((await attempt(rate.authFailure, "203.0.113.10")).status, "next", "another address is unaffected");
    mock.timers.tick(30_000);
    assert.equal((await attempt(rate.authFailure)).status, 429, "still locked half way through the window");
    assert.equal((await attempt(rate.authFailure)).headers["Retry-After"], "30");
    mock.timers.tick(30_001);
    assert.equal((await attempt(rate.authFailure)).status, "next", "free again once the window is over");
  } finally { mock.timers.reset(); await rate.close(); }
});

test("IPv6 clients are keyed by their /64, however the address is written", () => {
  const same = [["2001:db8::1:2:3:4", "2001:db8:0:0:ffff:eeee:dddd:cccc", "2001:0db8:0000:0000:1::9"], ["2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd:12::1"], ["fe80::1", "fe80:0:0:0:aaaa::2"]];
  for (const group of same) assert.equal(new Set(group.map(ipKey)).size, 1, `one key for ${group.join(", ")}`);
  assert.notEqual(ipKey("2001:db8:abcd:12::1"), ipKey("2001:db8:abcd:13::1"), "another /64 is another client");
  assert.notEqual(ipKey("2001:db8::1"), ipKey("2001:db9::1"));
  assert.equal(ipKey("::1"), "0000:0000:0000:0000");
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7", "IPv4 is unchanged");
  assert.equal(ipKey("::ffff:203.0.113.7"), "::ffff:203.0.113.7", "IPv4-mapped addresses are left alone");
  assert.equal(ipKey(undefined), "unknown");
});
