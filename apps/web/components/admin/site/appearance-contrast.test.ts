import { checkFloor, type CustomThemeSettings } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { contrastLine, failureText, floorReason } from "./appearance-contrast";

const custom = (accent: string): CustomThemeSettings => ({
  preset: "custom",
  accent,
  corners: "soft",
  font: "system",
});

describe("Appearance contrast wording (TH4)", () => {
  it("names the accent's text colour and its ratio in both themes, never rounding up", () => {
    const line = contrastLine(checkFloor(custom("#2449c7")));
    expect(line).toMatch(/^Accent text: white, \d+\.\d:1 light \/ (white, )?\d+\.\d:1 dark$/);
    expect(contrastLine(checkFloor(custom("#ffd400")))).toContain("near-black");
  });

  it("puts each failed rule in the admin's words, with the ratio", () => {
    expect(
      failureText({ rule: "fg_on_primary", scheme: "light", ratio: 3.12, required: 4.5 }),
    ).toBe("Text on the accent is too faint in the light theme (3.12:1; it needs 4.5:1).");
    expect(failureText({ rule: "link on panel", scheme: "dark", ratio: 4.1, required: 4.5 })).toBe(
      "Links are too faint on side panels in the dark theme (4.1:1; it needs 4.5:1).",
    );
    expect(
      failureText({ rule: "primary_on_surface", scheme: "both", ratio: 1.2, required: 3 }),
    ).toBe(
      "The accent barely stands out from the background in both themes (1.2:1; it needs 3:1).",
    );
    expect(failureText({ rule: "focus on card", scheme: "light", ratio: 2, required: 3 })).toBe(
      "Focus outlines are too faint on cards in the light theme (2:1; it needs 3:1).",
    );
    expect(failureText({ rule: "new_rule", scheme: "dark", ratio: 2, required: 3 })).toBe(
      "new_rule fails in the dark theme (2:1; it needs 3:1).",
    );
  });

  it("gives Save's reason from the first failure, or none when the accent passes", () => {
    expect(floorReason(checkFloor(custom("#2449c7")))).toBeNull();
    const refused = checkFloor(custom("#f4f4f6"));
    expect(refused.ok).toBe(false);
    expect(floorReason(refused)).toMatch(
      /^Save is off until the accent meets the contrast floor: .+:1/,
    );
  });
});
