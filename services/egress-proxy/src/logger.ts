import { pino } from "pino";

export const logger = pino({
  base: { service: "egress-proxy" },
  level: process.env.LOG_LEVEL ?? "info",
});
