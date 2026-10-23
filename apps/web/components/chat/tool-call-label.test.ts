import { describe, expect, it } from "vitest";
import { outcomeLabel } from "./tool-call";

describe("outcomeLabel (KOBE-493)", () => {
  it("says the write was refused because the member is viewing the file", () => {
    const denied = { reasons: [{ code: "viewed_file" }] };
    expect(outcomeLabel("denied", denied)).toBe("Not written: you're viewing this file");
  });

  it("keeps the generic labels otherwise", () => {
    expect(outcomeLabel("denied", { reasons: [{ code: "agent_tool_deny" }] })).toBe(
      "Denied by policy",
    );
    expect(outcomeLabel("denied", undefined)).toBe("Denied by policy");
    expect(outcomeLabel("done", { reasons: [{ code: "viewed_file" }] })).toBe("Done");
  });
});
