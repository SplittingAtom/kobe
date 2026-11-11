import { describe, expect, it } from "vitest";
import { headingSlug, rehypeHeadingIds } from "./heading-ids";

describe("rehypeHeadingIds (KOBE-616)", () => {
  it("slugs headings GitHub-style and numbers repeats", () => {
    expect(headingSlug(" Sign in, then chat! ")).toBe("sign-in-then-chat");
    const h = (tagName: string, text: string) => ({
      type: "element",
      tagName,
      properties: {},
      children: [{ type: "text", value: text }],
    });
    const tree = { type: "root", children: [h("h2", "Setup"), h("h3", "Setup"), h("p", "x")] };
    rehypeHeadingIds()(tree);
    expect(tree.children.map((c) => c.properties)).toEqual([
      { id: "setup" },
      { id: "setup-1" },
      {},
    ]);
  });
});
