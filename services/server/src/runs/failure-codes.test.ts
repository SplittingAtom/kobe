import { MODEL_RUN_ERROR_CODES } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FAILURE_MESSAGES, failureInfo } from "./failure-codes.js";

describe("run failure messages", () => {
  it("has the server's own message for every model run error code", () => {
    for (const code of MODEL_RUN_ERROR_CODES) {
      expect(FAILURE_MESSAGES[code], code).toMatch(/\S/);
    }
  });

  it("tells the user how to fix a budget below one model call (KOBE-259)", () => {
    expect(failureInfo("model_budget_too_small", "model_error")).toEqual({
      code: "model_budget_too_small",
      message:
        "The budget is smaller than one call to this model (its input plus its output limit), so the call was refused. Ask your team admin to raise the budget, or your site admin to lower the model's output limit.",
    });
  });
});
