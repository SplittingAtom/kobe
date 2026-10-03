import { describe, expect, it } from "vitest";
import { parseApprovalFloor, strictestApprovalMode } from "./approval-floor.js";

describe("approval floor (D6, D19, D29)", () => {
  it("orders modes auto < ask-on-write < ask-all", () => {
    expect(strictestApprovalMode("auto", "ask-on-write")).toBe("ask-on-write");
    expect(strictestApprovalMode("ask-all", "auto", "ask-on-write")).toBe("ask-all");
    expect(strictestApprovalMode("auto")).toBe("auto");
  });

  it("has no floor by default and fails closed on an unreadable value", () => {
    expect(parseApprovalFloor(undefined)).toBe("auto");
    expect(parseApprovalFloor("ask-on-write")).toBe("ask-on-write");
    expect(parseApprovalFloor("bypass")).toBe("ask-all");
    expect(parseApprovalFloor("")).toBe("ask-all");
  });
});
