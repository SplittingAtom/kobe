import { describe, expect, it } from "vitest";
import { casesFile } from "./cases.js";

describe("casesFile (KOBE-276)", () => {
  it("is null without cases, so a plain eval sends no file", () => {
    expect(casesFile([])).toBeNull();
  });

  it("carries the copy and the expected behaviour, nothing about who shared it", () => {
    const text = casesFile([
      {
        id: "0b7f6b2c-4a51-4f0e-9a43-5f1c7f3b9e21",
        expected: "Cite the census.",
        content: {
          prompt: "Population?",
          answer: "About a million.",
          earlier: [{ role: "user", text: "Capital?" }],
          tool_outputs: [{ tool: "search", text: "467,000", is_error: false }],
          attachments: [{ name: "a.csv", mime_type: "text/csv", size_bytes: 3 }],
          reasons: ["wrong"],
          comment: "Made up.",
          truncated: false,
        },
      },
    ]);
    expect(JSON.parse(text ?? "")).toEqual({
      schema_version: 1,
      suite: "shared-cases",
      cases: [
        {
          id: "0b7f6b2c-4a51-4f0e-9a43-5f1c7f3b9e21",
          prompt: "Population?",
          earlier: [{ role: "user", text: "Capital?" }],
          tool_outputs: [{ tool: "search", text: "467,000", is_error: false }],
          attachments: [{ name: "a.csv", mime_type: "text/csv", size_bytes: 3 }],
          rated_answer: "About a million.",
          reasons: ["wrong"],
          comment: "Made up.",
          expected: "Cite the census.",
        },
      ],
    });
  });
});
