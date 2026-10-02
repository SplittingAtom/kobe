import { pino } from "pino";

export const logger = pino({
  base: { service: "mcp-proxy" },
  level: process.env.LOG_LEVEL ?? "info",
});
