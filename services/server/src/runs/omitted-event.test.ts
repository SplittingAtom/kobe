import { describe, expect, it } from "vitest";
import { parseEventPayload } from "@kobe/protocol";
import { omittedItems } from "./omitted-event.js";

const o = (name: string) => ({
  kind: "connector" as const,
  name,
  reason: "not_team_enabled" as const,
});

describe("omittedItems (KOBE-77)", () => {
  it("clamps long names, drops empty ones, and the result is a valid payload", () => {
    const items = omittedItems([o("a".repeat(300)), o(""), o("  "), o("ok")]);
    expect(items?.map((i) => i.name.length)).toEqual([256, 2]);
    expect(items?.[0]?.name.endsWith("…")).toBe(true);
    expect(() => parseEventPayload("context.omitted", { items })).not.toThrow();
  });

  it("is undefined when nothing remains", () => {
    expect(omittedItems([])).toBeUndefined();
    expect(omittedItems([o("")])).toBeUndefined();
  });

  it("caps the item count", () => {
    expect(omittedItems(Array.from({ length: 150 }, (_, i) => o(`c${i}`)))).toHaveLength(100);
  });
});
