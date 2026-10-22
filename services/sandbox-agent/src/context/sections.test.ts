import { describe, expect, it } from "vitest";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  contextMessages,
  sectionsOf,
} from "./sections.js";
import { splitForcedPrompt, splitRenderedPrompt } from "./system-prompt.js";
import { VIEWING_HEADER, viewingContextText } from "../memory/viewing-context.js";
import { memoryContextText } from "../memory/context.js";

/** Pi 1.0.0's rendered prompt: preamble, then tagged sections joined by blank lines. */
const RENDERED = [
  "You are an expert coding assistant operating inside pi.",
  "<tools>\n- read: Read files\n</tools>",
  "<rules>\n- Be concise\n</rules>",
  "<addendum>\nYou are Kobe's agent. Follow the team's rules.\n</addendum>",
  "<skills>\n<available_skills>pdf</available_skills>\n</skills>",
  "<cwd>\n/workspace\n</cwd>",
].join("\n\n");

const kinds = (sections: { kind: string; label: string }[]) =>
  sections.map((s) => `${s.kind}:${s.label}`);

describe("system prompt sections (KOBE-470)", () => {
  it("splits Pi's rendered prompt into its named sections", () => {
    expect(kinds(splitRenderedPrompt(RENDERED))).toEqual([
      "system_prompt:Pi's prompt",
      "system_prompt:Tool guidance",
      "system_prompt:Rules",
      "agent_instructions:Agent instructions",
      "skills:Skills",
      "system_prompt:Working directory",
    ]);
    expect(
      splitRenderedPrompt(RENDERED)
        .map((s) => s.text)
        .join("\n\n"),
    ).toBe(RENDERED);
  });

  it("keeps what does not parse as one section", () => {
    const odd = "Preamble\n\n<tools>\nnever closed";
    expect(splitRenderedPrompt(odd).map((s) => s.text)).toEqual([
      "Preamble",
      "\n\n<tools>\nnever closed",
    ]);
  });

  const memory = memoryContextText(
    {
      scopes: ["user"],
      indexes: [{ scope: "user", content: "- likes tea", version: 1, truncated: false }],
    },
    "0123456789abcdef",
  ) as string;
  const viewing = viewingContextText(
    { path: "notes.md", sha256: "a".repeat(64), size: 5, content: "hello", truncated: false },
    "fedcba9876543210",
  ) as string;

  it("splits a forced prompt exactly by the run's parts", () => {
    const forced = `${RENDERED}\n\n${memory}\n\n${viewing}`;
    const sections = splitForcedPrompt(forced, { memory, project: "", viewing });
    expect(kinds(sections).slice(-2)).toEqual(["memory:Saved memory", "viewing_file:Viewed file"]);
    expect(sections.at(-1)?.text).toBe(viewing);
    expect(sections.map((s) => s.text).join("\n\n")).toBe(forced);
  });

  it("finds the parts by their headers when the run's parts changed since", () => {
    const forced = `${RENDERED}\n\n${memory}\n\n${viewing}`;
    const sections = splitForcedPrompt(forced, { memory: "other", project: "", viewing: "" });
    expect(kinds(sections).slice(-2)).toEqual(["memory:Saved memory", "viewing_file:Viewed file"]);
    expect(sections.at(-2)?.text).toBe(memory);
  });

  describe("at most one viewed-file section (KOBE-473)", () => {
    const viewingOf = (file: string, content: string) =>
      viewingContextText(
        { path: file, sha256: "b".repeat(64), size: content.length, content, truncated: false },
        "0011223344556677",
      ) as string;
    const viewings = <T extends { kind: string }>(sections: T[]) =>
      sections.filter((s) => s.kind === "viewing_file");
    // A file that quotes the section's own header, as a doc about Kobe might.
    const quoting = viewingOf("a.md", `# Notes\n\n${VIEWING_HEADER}\nquoted\n`);

    it("splits a file that quotes the viewed-file header into one section", () => {
      const forced = `${RENDERED}\n\n${quoting}`;
      for (const parts of [{ memory: "", project: "", viewing: quoting }, undefined]) {
        const sections = splitForcedPrompt(forced, parts);
        expect(viewings(sections)).toEqual([
          { kind: "viewing_file", label: "Viewed file", text: quoting },
        ]);
      }
    });

    it("splits an older call by its own file when the next run's parts are already written", () => {
      const next = viewingOf("b.md", "beta");
      const sections = splitForcedPrompt(`${RENDERED}\n\n${quoting}`, {
        memory: "",
        project: "",
        viewing: next,
      });
      expect(viewings(sections).map((s) => s.text)).toEqual([quoting]);
    });

    it("has none for a call without a viewed file", () => {
      const parts = { memory: "", project: "", viewing: quoting };
      expect(viewings(splitForcedPrompt(`${RENDERED}\n\n${memory}`, parts))).toEqual([]);
      expect(viewings(splitRenderedPrompt(RENDERED))).toEqual([]);
    });
  });
});

describe("context sections (KOBE-470)", () => {
  it("orders the prompt, tools and messages as the model got them", () => {
    const messages = [
      {
        role: "system",
        content: "",
        sections: { preamble: "Pi", addendum: "<addendum>\nBe Kobe\n</addendum>" },
        toolsAdded: [{ name: "bash", description: "Run", parameters: { type: "object" } }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", mimeType: "image/png", data: "" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Let me look." },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "a.txt" }],
        isError: true,
      },
      { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}earlier${COMPACTION_SUMMARY_SUFFIX}` },
      { role: "system", content: "", sections: { skills: null } },
    ];
    const sections = sectionsOf(messages);
    expect(kinds(sections)).toEqual([
      "system_prompt:Pi's prompt",
      "agent_instructions:Agent instructions",
      "tool_definitions:bash",
      "user_message:User",
      "assistant_message:Thinking",
      "assistant_message:Assistant",
      "tool_call:bash",
      "tool_result:bash (error)",
      "compaction_summary:Compaction summary",
      "other:Skills (updated): removed",
    ]);
    expect(sections[3]).toMatchObject({ text: "hi\n[image image/png]", images: 1 });
    expect(JSON.parse(sections[6]?.text ?? "")).toEqual({ command: "ls" });
  });

  it("puts a raw Context's prompt and tools first, and converts session summaries", () => {
    const messages = contextMessages({
      systemPrompt: "Be brief",
      tools: [{ name: "read" }],
      messages: [
        { role: "compactionSummary", summary: "S" },
        { role: "custom", customType: "kobe.app", content: "card" },
      ],
    });
    expect(kinds(sectionsOf(messages))).toEqual([
      "system_prompt:Pi's prompt",
      "tool_definitions:read",
      "compaction_summary:Compaction summary",
      "other:kobe.app",
    ]);
    expect(sectionsOf(messages)[2]?.text).toBe(
      `${COMPACTION_SUMMARY_PREFIX}S${COMPACTION_SUMMARY_SUFFIX}`,
    );
  });
});
