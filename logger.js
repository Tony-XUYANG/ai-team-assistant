const { randomUUID } = require("node:crypto");
const { hostname } = require("node:os");
const { version } = require("./package.json");

const errorCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EADDRINUSE", "EACCES", "28P01", "3D000",
  "53300", "57P01", "57P02", "57P03", "42P01", "42703", "42501", "23505", "57014", "08006", "08001",
]);
const fields = new Set([
  "requestId", "method", "route", "status", "durationMs", "errorCode",
  "dependency", "operation", "port", "signal",
]);

function requestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
    ? value : randomUUID();
}

function safeErrorCode(error) {
  return errorCodes.has(error?.code) ? error.code : "UNCLASSIFIED";
}

function createLogger(write = line => process.stdout.write(line)) {
  return (level, event, context = {}) => {
    const record = { timestamp: new Date().toISOString(), level, event, version, hostname: hostname() };
    // Only explicitly selected scalar fields can reach the log sink.
    for (const [key, value] of Object.entries(context)) {
      if (fields.has(key) && ["string", "number", "boolean"].includes(typeof value)) {
        record[key] = value;
      }
    }
    write(JSON.stringify(record) + "\n");
  };
}

module.exports = { createLogger, log: createLogger(), requestId, safeErrorCode };
