import { pino } from "pino";

export const logger = pino({
  base: { service: "sandbox-agent" },
  level: process.env.LOG_LEVEL ?? "info",
  // Defence in depth: the wire token is only ever placed in a request header, never logged.
  redact: { paths: ["token", "authorization", "headers.authorization", "*.token"], remove: true },
});
