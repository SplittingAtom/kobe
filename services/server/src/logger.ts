import { pino } from "pino";

export const logger = pino({ base: { service: "server" }, level: process.env.LOG_LEVEL ?? "info" });
