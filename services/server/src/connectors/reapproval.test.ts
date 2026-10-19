import { describe, expect, it } from "vitest";
import { applyDrift } from "./drift.js";
import { buildSnapshot } from "./pin.js";
import { reviewOf } from "./reapproval.js";

/** KOBE-434 review M4: the tool review shows `ui` and annotations, so their drift is visible. */
const tool = (ui: Record<string, unknown> | undefined, readOnlyHint = true) => {
  const s = buildSnapshot("srv", [
    {
      name: "t",
      description: "d",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint },
      ...(ui === undefined ? {} : { _meta: { ui } }),
    },
  ]);
  if (!s.ok) throw new Error("fixture");
  return s.tools;
};

describe("reviewOf with MCP Apps fields", () => {
  it("shows a visibility-only change between the approved and live definitions", () => {
    const r = applyDrift(tool({ visibility: ["app"] }), tool(undefined));
    const review = reviewOf(r.tools[0] ?? (undefined as never));
    expect(review).toMatchObject({
      change: "changed",
      approved: { ui: { visibility: ["app"] }, annotations: { readOnlyHint: true } },
    });
    expect(review.live).not.toHaveProperty("ui");
  });

  it("shows a template reference and its change", () => {
    const r = applyDrift(tool({ resourceUri: "ui://s/a" }), tool({ resourceUri: "ui://s/b" }));
    expect(reviewOf(r.tools[0] ?? (undefined as never))).toMatchObject({
      approved: { ui: { resourceUri: "ui://s/a" } },
      live: { ui: { resourceUri: "ui://s/b" } },
    });
  });
});
