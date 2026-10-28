// JUnit XML for CI systems. Only fields WirePulse actually records are emitted: per-test status and attempt counts.
const INVALID_XML = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g;
const escapeXml = (value) => String(value).replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function toJunit({ name, results, timestamp, evidenceFinalHash }) {
  const failures = results.filter((item) => item.status === "failed").length;
  const skipped = results.filter((item) => item.status === "not-run").length;
  const cases = results.map((item) => {
    const open = `<testcase classname="${escapeXml(name)}" name="${escapeXml(item.testId)}">`;
    if (item.status === "failed") return `    ${open}<failure message="assertion failed after ${Number(item.attempts) || 0} attempt(s)"/></testcase>`;
    if (item.status === "not-run") return `    ${open}<skipped/></testcase>`;
    return `    ${open}</testcase>`;
  });
  const properties = evidenceFinalHash ? `\n    <properties><property name="evidenceFinalHash" value="${escapeXml(evidenceFinalHash)}"/></properties>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${escapeXml(name)}" tests="${results.length}" failures="${failures}" errors="0" skipped="${skipped}" timestamp="${new Date(timestamp).toISOString()}">${properties}\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
}
