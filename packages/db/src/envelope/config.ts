import { MIN_SECRET_LENGTH } from "../models/secret-box.js";
import { Envelope, EnvelopeError } from "./envelope.js";

export const ENVELOPE_KEY_ENV = "KOBE_ENVELOPE_KEY";
export const ENVELOPE_KEY_PREVIOUS_ENV = "KOBE_ENVELOPE_KEY_PREVIOUS";

interface Logger {
  info(obj: object, msg?: string): void;
}

/**
 * The install envelope from env (the chart's Secret), or undefined when unset. Invalid values fail
 * fast; messages name the variable only, never its value. Logs the key id (not secret) once.
 */
export function loadEnvelope(
  env: Readonly<Record<string, string | undefined>>,
  logger?: Logger,
): Envelope | undefined {
  const current = env[ENVELOPE_KEY_ENV] ?? "";
  const previous = env[ENVELOPE_KEY_PREVIOUS_ENV] ?? "";
  if (current === "") {
    if (previous !== "") {
      throw new EnvelopeError(`${ENVELOPE_KEY_PREVIOUS_ENV} needs ${ENVELOPE_KEY_ENV}`);
    }
    return undefined;
  }
  for (const [name, value] of [
    [ENVELOPE_KEY_ENV, current],
    [ENVELOPE_KEY_PREVIOUS_ENV, previous],
  ] as const) {
    if (value !== "" && value.length < MIN_SECRET_LENGTH) {
      throw new EnvelopeError(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  const envelope = new Envelope(previous === "" ? [current] : [current, previous]);
  logger?.info({ keyId: envelope.currentKeyId }, "envelope encryption key loaded");
  return envelope;
}
