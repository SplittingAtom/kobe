import { pino } from "pino";

export const logger = pino({
  base: { service: "model-gateway" },
  level: process.env.LOG_LEVEL ?? "info",
});
