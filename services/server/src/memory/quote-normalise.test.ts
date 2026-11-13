import { describe, expect, it } from "vitest";
import { normaliseQuote, quoteFoundIn } from "./quote-normalise.js";

/** KOBE-379 ac-4: the shared quote normaliser KOBE-393 (SMB5) verifies evidence quotes with. */
describe("normaliseQuote", () => {
  it.each([
    ["curly double quotes", "\u201cship it\u201d", '"ship it"'],
    ["low and angle quotes", "\u201eja\u201c \u00abnon\u00bb", '"ja" "non"'],
    ["curly single quotes and apostrophes", "it\u2019s \u2018fine\u2019", "it's 'fine'"],
    ["primes and acute accent", "5\u2032 10\u2033 don\u00b4t", "5' 10\" don't"],
    ["en, em, minus and figure dashes", "a\u2013b\u2014c\u2212d\u2012e", "a-b-c-d-e"],
    ["full-width letters (NFKC)", "\uff21\uff30\uff29 \uff4b\uff45\uff59", "API key"],
    ["ligatures and ellipsis (NFKC)", "\ufb01le\u2026", "file..."],
    ["non-breaking and thin spaces", "a\u00a0b\u2009c", "a b c"],
    ["zero-width and bidi characters", "pa\u200bss\u200dwo\u202erd\u2060", "password"],
    ["runs of whitespace and newlines", "  one\n\n two\t three  ", "one two three"],
  ])("folds %s", (_name, input, expected) => {
    expect(normaliseQuote(input)).toBe(expected);
  });

  it("keeps case and emoji sequences", () => {
    expect(normaliseQuote("Deploy \u{1f468}\u200d\u{1f4bb} ON Friday")).toBe(
      "Deploy \u{1f468}\u200d\u{1f4bb} ON Friday",
    );
  });

  it("is idempotent", () => {
    const once = normaliseQuote("\u201cWe\u2019ll ship \u2014 maybe\u2026\u201d");
    expect(normaliseQuote(once)).toBe(once);
  });
});

describe("quoteFoundIn", () => {
  const thread = "Chris: \u201cWe deploy on Tuesdays\u2014never on Fridays.\u201d\n\nOK.";

  it("finds a quote typed with straight quotes and a plain dash", () => {
    expect(quoteFoundIn('"We deploy on Tuesdays-never on Fridays."', thread)).toBe(true);
  });

  it("ignores extra whitespace and invisible characters in either text", () => {
    expect(quoteFoundIn("deploy  on\u200b Tuesdays", thread)).toBe(true);
  });

  it("is case-sensitive unless asked", () => {
    expect(quoteFoundIn("we deploy on tuesdays", thread)).toBe(false);
    expect(quoteFoundIn("we deploy on tuesdays", thread, { caseInsensitive: true })).toBe(true);
  });

  it("never finds an empty or blank quote, nor words that aren't there", () => {
    expect(quoteFoundIn("", thread)).toBe(false);
    expect(quoteFoundIn(" \u200b ", thread)).toBe(false);
    expect(quoteFoundIn("We deploy on Fridays", thread)).toBe(false);
  });
});
