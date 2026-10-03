import { pino, type LoggerOptions } from "pino";
import { serializeError } from "./log-safety.js";

/** Shared options: errors are serialized without query parameters or content (log-safety.ts). */
export const LOGGER_OPTIONS: LoggerOptions = {
  base: { service: "server" },
  level: process.env.LOG_LEVEL ?? "info",
  serializers: { err: serializeError, error: serializeError },
};

export const logger = pino(LOGGER_OPTIONS);
