import { describe, expect, it } from "vitest";
import {
  GENERATED_TITLE_MAX_CHARS,
  SERVER_CALL_MAX_BODY_BYTES,
  SERVER_CALL_MESSAGE_MAX_CHARS,
  serverCallRequestSchema,
} from "@kobe/protocol";
import { fallbackTitle, normaliseTitle, titleMessages } from "./title.js";

describe("normaliseTitle (KOBE-219 ac-5: generatedTitleSchema)", () => {
  it.each([
    ["Quarterly revenue drivers", "Quarterly revenue drivers"],
    ['"Quarterly revenue drivers."', "Quarterly revenue drivers"],
    ["“Revenue by region”", "Revenue by region"],
    ["Title: Revenue by region", "Revenue by region"],
    ["**Revenue by region**", "Revenue by region"],
    ["# Revenue by region!", "Revenue by region"],
    ["\n\n  Revenue   by\tregion  \nSecond line", "Revenue by region"],
    ["'Why sales dipped?'", "Why sales dipped"],
  ])("%j → %j", (reply, title) => {
    expect(normaliseTitle(reply)).toBe(title);
  });

  it("cuts long titles at a word boundary within the limit", () => {
    const long = "word ".repeat(40);
    const t = normaliseTitle(long);
    expect(t).toBeDefined();
    expect(t?.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX_CHARS);
    expect(t?.endsWith(" ")).toBe(false);
    expect(normaliseTitle("x".repeat(200))?.length).toBe(GENERATED_TITLE_MAX_CHARS);
  });

  it.each(["", "   \n  ", '""', "...", "Title:", "\u0000\u0007"])(
    "gives nothing usable for %j",
    (reply) => {
      expect(normaliseTitle(reply)).toBeUndefined();
    },
  );

  it("drops control characters", () => {
    expect(normaliseTitle("Rev\u0007enue")).toBe("Revenue");
  });

  it("drops bidi controls, zero-width marks and C1 controls; splits on Unicode separators (review L1)", () => {
    expect(normaliseTitle("Rev\u202Eenue\u200B drivers")).toBe("Revenue drivers");
    expect(normaliseTitle("\u2066Q3\u2069 plan\u0085second line")).toBe("Q3 plan");
    expect(normaliseTitle("First\u2028Second")).toBe("First");
    expect(normaliseTitle("\u200B\u200F")).toBeUndefined();
  });

  it.each(["Verify at https://evil.example", "See www.evil.example now", "[Login](x)"])(
    "refuses a title that carries a link: %j (review L2)",
    (reply) => {
      expect(normaliseTitle(reply)).toBeUndefined();
    },
  );
});

describe("fallbackTitle (review M3)", () => {
  it("is the first line of the prompt, cleaned, cut with an ellipsis", () => {
    expect(fallbackTitle("  Plot revenue\nby month  ")).toBe("Plot revenue");
    expect(fallbackTitle("Rev\u202Eenue   by\tregion")).toBe("Revenue by region");
    const long = fallbackTitle("word ".repeat(40));
    expect(long?.endsWith("…")).toBe(true);
    expect(long?.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX_CHARS);
    expect(fallbackTitle("x".repeat(200))?.length).toBe(GENERATED_TITLE_MAX_CHARS);
    expect(fallbackTitle("  \n ")).toBeUndefined();
  });
});

describe("titleMessages (KOBE-234 request shape)", () => {
  it("quotes the first message and the start of the answer, truncated, as a valid request", () => {
    const messages = titleMessages("x".repeat(100_000), "y".repeat(100_000));
    const body = serverCallRequestSchema.parse({
      model: "openai/gpt-x",
      messages,
      max_tokens: 64,
      stream: false,
    });
    expect(body.messages.length).toBeLessThanOrEqual(4);
    for (const m of body.messages) {
      expect(m.content.length).toBeLessThanOrEqual(SERVER_CALL_MESSAGE_MAX_CHARS);
    }
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(SERVER_CALL_MAX_BODY_BYTES);
    expect(JSON.stringify(messages)).toContain("xxxx");
    expect(JSON.stringify(messages)).toContain("yyyy");
  });

  it("works without an answer", () => {
    const messages = titleMessages("What drives revenue?", undefined);
    expect(JSON.stringify(messages)).toContain("What drives revenue?");
    expect(messages.at(-1)?.role).toBe("user");
  });
});
