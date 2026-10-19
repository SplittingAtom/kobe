import { createHash } from "node:crypto";

/** An app's id (spec §6): the SHA-256 (hex) of `connectorId:uri`. */
export const appIdOf = (connectorId: string, uri: string): string =>
  createHash("sha256").update(`${connectorId}:${uri}`, "utf8").digest("hex");

export const APP_ID_PATTERN = /^[0-9a-f]{64}$/;
