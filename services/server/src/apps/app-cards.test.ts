import { describe, expect, it } from "vitest";
import type { MemberApp } from "./catalog.js";
import { resultText, titleOf } from "./app-cards.js";

const app = (tool: Record<string, unknown>) =>
  ({ tool: { name: "open_explorer", annotations: {}, ...tool } }) as unknown as MemberApp;

describe("app card titles and text (KOBE-440 review LOW-5)", () => {
  it("titles a new thread after the app, with the title rules' unsafe characters removed", () => {
    expect(titleOf(app({ title: "Lakehouse Explorer" }))).toBe("Lakehouse Explorer");
    expect(titleOf(app({ title: "Lake‮house​\u0007 Explorer" }))).toBe("Lakehouse Explorer");
    expect(titleOf(app({ annotations: { title: "From annotations" } }))).toBe("From annotations");
    expect(titleOf(app({ title: "‮​" }))).toBe("open_explorer");
    expect(titleOf(app({ title: "x".repeat(500) })).length).toBeLessThanOrEqual(120);
  });

  it("joins the text blocks of a result, and says when there is none", () => {
    expect(
      resultText({
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      }),
    ).toBe("a\nb");
    expect(resultText({ structuredContent: {} })).toBe("(The app's tool returned no text.)");
  });
});
