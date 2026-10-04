import { describe, expect, it } from "vitest";
import {
  KOBE_MODEL_ERROR_PREFIX,
  MODEL_RUN_ERROR_CODES,
  kobeModelErrorMessage,
  parseKobeModelError,
} from "./pi-events.js";

describe("kobe-models error messages (sandbox → server, in Pi's errorMessage)", () => {
  it("round-trips a code through the message the extension writes", () => {
    const message = kobeModelErrorMessage("model_not_enabled", "That model is not enabled.");
    expect(message.startsWith(KOBE_MODEL_ERROR_PREFIX)).toBe(true);
    expect(parseKobeModelError(message)).toBe("model_not_enabled");
  });

  it("accepts every documented code and nothing else", () => {
    for (const code of MODEL_RUN_ERROR_CODES) {
      expect(parseKobeModelError(`${KOBE_MODEL_ERROR_PREFIX}${code}: detail`)).toBe(code);
    }
    expect(parseKobeModelError(`${KOBE_MODEL_ERROR_PREFIX}made_up: x`)).toBeUndefined();
    expect(parseKobeModelError(`${KOBE_MODEL_ERROR_PREFIX}MODEL_ERROR: x`)).toBeUndefined();
  });

  it("ignores anything that is not a kobe-models message (untrusted Pi output)", () => {
    expect(parseKobeModelError(undefined)).toBeUndefined();
    expect(parseKobeModelError(42)).toBeUndefined();
    expect(parseKobeModelError('403: {"error":{"code":"model_not_enabled"}}')).toBeUndefined();
    expect(parseKobeModelError(` ${KOBE_MODEL_ERROR_PREFIX}model_error: x`)).toBeUndefined();
    expect(parseKobeModelError(`x${KOBE_MODEL_ERROR_PREFIX}model_error`)).toBeUndefined();
  });

  it("keeps the detail out of the parsed result (the server never shows sandbox text)", () => {
    expect(parseKobeModelError(`${KOBE_MODEL_ERROR_PREFIX}model_error: <script>`)).toBe(
      "model_error",
    );
  });
});
