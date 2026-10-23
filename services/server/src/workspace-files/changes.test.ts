import { describe, expect, it } from "vitest";
import { workspaceChangeActorSchema } from "@kobe/protocol";
import { actorName } from "./changes.js";

describe("actorName (KOBE-496 review)", () => {
  it("keeps a normal name, and always fits the contract", () => {
    expect(actorName("Ann Lee")).toBe("Ann Lee");
    expect(actorName(null)).toBeNull();
    expect(actorName("")).toBeNull();
    expect(actorName("  \n\t ")).toBeNull();
    expect(actorName("Ann\u0000\nLee")).toBe("Ann Lee");
    const long = actorName("x".repeat(500));
    expect(long).toHaveLength(200);
    // A surrogate pair cut at the limit loses its half.
    const emoji = actorName(`${"y".repeat(199)}😀tail`);
    expect(emoji).toBe("y".repeat(199));
    for (const name of [long, emoji, actorName("Ann")]) {
      expect(workspaceChangeActorSchema.safeParse({ kind: "user", name }).success).toBe(true);
    }
  });
});
