import pino from "pino";

const TOKEN = /\bwp[gk]_[A-Za-z0-9_-]{8,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// Gateway/API-key tokens and bearer credentials must never reach a log line, even inside an error message.
export const maskSecrets = (text) => String(text).replace(TOKEN, "wp?_[redacted]").replace(BEARER, "Bearer [redacted]");

function serializeError(error) {
  const base = pino.stdSerializers.err(error);
  return { ...base, message: maskSecrets(base.message), stack: base.stack ? maskSecrets(base.stack) : undefined };
}

export function createLogger({ level = "info", destination } = {}) {
  return pino({
    level,
    base: { service: "wirepulse-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: serializeError },
    redact: { paths: ["authorization", "headers.authorization", "req.headers.authorization", "token", "*.token", "*.tokenHash", "*.password", "*.secret"], censor: "[redacted]" }
  }, destination);
}
