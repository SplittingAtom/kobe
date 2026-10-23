import { describe, expect, it } from "vitest";
import { withItemReferences, withSkillRequest } from "@kobe/protocol";
import { memberText } from "./messages.js";

describe("memberText", () => {
  it("drops the server's skill line (KOBE-451): titles and cards read the member's text", () => {
    expect(memberText(withSkillRequest("pretty-html", " Make it pretty "))).toBe("Make it pretty");
    expect(memberText("Plain")).toBe("Plain");
  });

  it("drops the server's references line (KOBE-490)", () => {
    const refs = [{ name: "cat.ns.orders", kind: "table" as const }];
    expect(memberText(withSkillRequest("x", withItemReferences(refs, "Look")))).toBe("Look");
  });
});
