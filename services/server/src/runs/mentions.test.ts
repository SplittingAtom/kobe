import { describe, expect, it } from "vitest";
import { encodeMentionPath, findMentionMarkers, mentionMarker } from "@kobe/protocol";
import { RunError } from "./errors.js";
import { mentionedPath, promptPath } from "./mentions.js";

/** The path a raw marker text resolves to, or the refusal's code. */
function resolve(markerText: string): string {
  const [marker] = findMentionMarkers(markerText);
  if (!marker) return "no marker";
  try {
    return mentionedPath(marker);
  } catch (err) {
    if (err instanceof RunError) return `refused:${err.code}`;
    throw err;
  }
}
const raw = (path: string) => `@file(${encodeMentionPath(path)})`;

describe("@file mention paths (KOBE-223, ac-3)", () => {
  it("accepts workspace-relative paths and absolute paths inside /workspace", () => {
    expect(resolve(mentionMarker("data/sales.csv"))).toBe("data/sales.csv");
    expect(resolve(raw("/workspace/data/sales.csv"))).toBe("data/sales.csv");
    expect(resolve(mentionMarker("uploads/x (1).txt"))).toBe("uploads/x (1).txt");
  });

  it("refuses absolute paths outside /workspace", () => {
    for (const p of [
      "/etc/passwd",
      "/workspace",
      "/workspace/",
      "/workspaces/a",
      "//workspace/a",
    ]) {
      expect(resolve(raw(p)), p).toBe("refused:invalid_mention");
    }
  });

  it("refuses traversal and empty or dot segments, however they are encoded", () => {
    for (const p of ["../etc/passwd", "a/../../b", "./a", "a//b", "a/.", "/workspace/../etc"]) {
      expect(resolve(raw(p)), p).toBe("refused:invalid_mention");
    }
    // `%2e%2e` decodes to `..` (decoded once, then checked).
    expect(resolve("@file(%2e%2e/secret)")).toBe("refused:invalid_mention");
    expect(resolve("@file(a%2F..%2F..%2Fb)")).toBe("refused:invalid_mention");
  });

  it("refuses NUL, control characters, line separators, backslashes and bidi controls", () => {
    for (const p of ["a\u0000b", "a\nb", "a\u0085b", "a b", "a\\b", "a‮b.txt"]) {
      expect(resolve(raw(p)), JSON.stringify(p)).toBe("refused:invalid_mention");
    }
  });

  it("refuses malformed encodings and overlong paths", () => {
    expect(resolve("@file(a%zz)")).toBe("refused:invalid_mention");
    expect(resolve("@file(%C0%AF)")).toBe("refused:invalid_mention");
    expect(resolve(mentionMarker(`${"a".repeat(256)}.txt`))).toBe("refused:invalid_mention");
    expect(resolve(mentionMarker(Array.from({ length: 300 }, () => "abcd").join("/")))).toBe(
      "refused:invalid_mention",
    );
  });
});

describe("the path written into the prompt", () => {
  it("is plain when it has no spaces or punctuation that could blur it", () => {
    expect(promptPath("uploads/t/e2e-upload.txt")).toBe("/workspace/uploads/t/e2e-upload.txt");
    expect(promptPath("Berichte/Übersicht_2026.pdf")).toBe(
      "/workspace/Berichte/Übersicht_2026.pdf",
    );
  });

  it("is a Markdown code span otherwise, fenced past any backticks in the name", () => {
    expect(promptPath("my data/q3 (final).csv")).toBe("`/workspace/my data/q3 (final).csv`");
    expect(promptPath("a`b.txt")).toBe("``/workspace/a`b.txt``");
    expect(promptPath("x/`b`")).toBe("`` /workspace/x/`b` ``");
  });
});
