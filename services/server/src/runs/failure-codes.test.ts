import { MODEL_RUN_ERROR_CODES } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FAILURE_MESSAGES, failureInfo } from "./failure-codes.js";

describe("run failure messages", () => {
  it("has the server's own message for every model run error code", () => {
    for (const code of MODEL_RUN_ERROR_CODES) {
      expect(FAILURE_MESSAGES[code], code).toMatch(/\S/);
    }
  });

  it("tells the user how to fix a request larger than the budget (KOBE-259)", () => {
    expect(failureInfo("model_budget_too_small", "model_error")).toEqual({
      code: "model_budget_too_small",
      message:
        "The request's input is larger than the whole budget, so the model call was refused. Ask your team admin to raise the budget, or start a new conversation with less context.",
    });
  });
});
