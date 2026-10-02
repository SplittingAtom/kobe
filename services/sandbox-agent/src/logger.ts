import { pino } from "pino";

export const logger = pino({
  base: { service: "sandbox-agent" },
  level: process.env.LOG_LEVEL ?? "info",
});
