import { describe, expect, it } from "vitest";
import { APP_CONTEXT_MAX_BYTES, APP_CONTEXT_MAX_PARTS } from "./app-context.js";
import { submitMessageBodySchema } from "./run-orchestrator.js";

/** KOBE-439 (MA-7, spec §8): model context from MCP Apps goes with the member's message. */
const part = {
  connector_id: "11111111-1111-4111-8111-111111111111",
  app_id: "a".repeat(64),
  template_sha256: "b".repeat(64),
  data: { structuredContent: { table: "c.n.t" } },
};
const parse = (app_context: unknown) =>
  submitMessageBodySchema.safeParse({ content: "Use it", app_context });

describe("app_context on a message (KOBE-439)", () => {
  it("takes one part per app, each with content and/or structured content", () => {
    expect(parse([part]).success).toBe(true);
    expect(parse([{ ...part, data: { content: [{ type: "text", text: "t" }] } }]).success).toBe(
      true,
    );
    expect(submitMessageBodySchema.parse({ content: "x" }).app_context).toBeUndefined();
  });

  it("caps each part at 8 KiB and the parts at three, distinct by app", () => {
    expect(APP_CONTEXT_MAX_BYTES).toBe(8 * 1024);
    const big = { ...part, data: { structuredContent: { x: "y".repeat(APP_CONTEXT_MAX_BYTES) } } };
    expect(parse([big]).success).toBe(false);
    const parts = Array.from({ length: APP_CONTEXT_MAX_PARTS + 1 }, (_, i) => ({
      ...part,
      app_id: String(i).repeat(64).slice(0, 64),
    }));
    expect(parse(parts).success).toBe(false);
    expect(parse([part, part]).success).toBe(false);
    expect(parse([]).success).toBe(false);
  });

  it("refuses malformed parts and extra keys", () => {
    expect(parse([{ ...part, app_id: "x" }]).success).toBe(false);
    expect(parse([{ ...part, data: {} }]).success).toBe(false);
    expect(parse([{ ...part, html: "<p>" }]).success).toBe(false);
  });
});
