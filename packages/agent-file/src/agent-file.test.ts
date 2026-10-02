import { describe, expect, it } from "vitest";
import {
  AGENT_FILE_LIMITS,
  agentSkills,
  agentWarnings,
  parseAgentFile,
  serializeAgentFile,
  slugFromName,
  validateAgentDefinition,
  type AgentDefinition,
} from "./index.js";

/** The example agent file from spec §6.3. */
const SPEC_EXAMPLE = `---
name: Release Notes Writer
role: Drafts release notes from merged pull requests and Jira tickets
description: Turns a release tag into user-facing notes
model: smart
skills: [docx]
connectors: [github, jira]
tools: { deny: ["bash:rm -rf*"] }
approval_mode: ask-on-write
starters: ["Draft notes for the latest tag"]
---
You write concise, user-facing release notes grouped by feature area…
`;

function parsed(text: string): AgentDefinition {
  const result = parseAgentFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

function issuesOf(text: string): string[] {
  const result = parseAgentFile(text);
  if (result.ok) throw new Error("expected the file to be rejected");
  return result.issues.map((i) => `${i.path}: ${i.message}`);
}

const file = (frontmatter: string, body = "Prompt.") => `---\n${frontmatter}\n---\n${body}\n`;

describe("parseAgentFile: the spec §6.3 example", () => {
  it("parses every field", () => {
    expect(parsed(SPEC_EXAMPLE)).toEqual({
      frontmatter: {
        name: "Release Notes Writer",
        role: "Drafts release notes from merged pull requests and Jira tickets",
        description: "Turns a release tag into user-facing notes",
        model: "smart",
        skills: ["docx"],
        connectors: ["github", "jira"],
        tools: { deny: ["bash:rm -rf*"] },
        approval_mode: "ask-on-write",
        starters: ["Draft notes for the latest tag"],
      },
      prompt: "You write concise, user-facing release notes grouped by feature area…",
    });
  });

  it("needs only a name", () => {
    expect(parsed(file("name: Minimal", ""))).toEqual({
      frontmatter: { name: "Minimal" },
      prompt: "",
    });
  });

  it("uses the protocol's connector names (D27), which allow single underscores", () => {
    expect(
      parsed(file("name: A\nconnectors: [google_drive, jira-cloud]")).frontmatter.connectors,
    ).toEqual(["google_drive", "jira-cloud"]);
  });

  it("accepts every approval mode (D29) and the icon forms", () => {
    for (const mode of ["ask-on-write", "ask-all", "auto"]) {
      expect(parsed(file(`name: A\napproval_mode: ${mode}`)).frontmatter.approval_mode).toBe(mode);
    }
    expect(parsed(file("name: A\nicon: bar-chart")).frontmatter.icon).toBe("bar-chart");
    expect(parsed(file("name: A\nicon: 📊")).frontmatter.icon).toBe("📊");
  });
});

describe("round trip (import → export → import is stable)", () => {
  const cases: Record<string, string> = {
    "spec example": SPEC_EXAMPLE,
    minimal: file("name: Minimal", ""),
    "CRLF line endings and a BOM": `\uFEFF${SPEC_EXAMPLE.replace(/\n/g, "\r\n")}`,
    "block-style lists and blank lines around the prompt": file(
      "name: Analyst\nskills:\n  - data-analysis\n  - charts\ntools:\n  allow: [read_file]\n  deny: []",
      "\n\n# Role\n\nYou analyse data.\n\n    indented code\n\n\n",
    ),
    "strings that look like other YAML types": file(
      `name: "123"\nrole: "yes"\ndescription: "null"\nstarters: ["# heading", "- dash", "key: value", "multi\\nline"]`,
    ),
    "exclusive skills": file("name: A\nskills: { exclusive: [docx, pdf] }"),
    "exclusive shorthand": file("name: A\nskills: exclusive"),
    "a body containing frontmatter-like delimiters": file("name: A", "Start\n---\nnot: yaml\n---"),
    unicode: file("name: Ünïcödé 助手\nicon: 🧑‍💻", "Réponds en français. 日本語も。"),
  };

  it.each(Object.entries(cases))("%s", (_name, text) => {
    const first = parsed(text);
    const exported = serializeAgentFile(first);
    const second = parsed(exported);
    expect(second).toEqual(first);
    // The export is canonical: exporting again yields byte-identical text.
    expect(serializeAgentFile(second)).toBe(exported);
  });

  it("exports with frontmatter keys in schema order regardless of input order", () => {
    const exported = serializeAgentFile(
      parsed(file("starters: [Go]\nmodel: fast\nname: Ordered\napproval_mode: auto")),
    );
    expect(exported).toBe(
      "---\nname: Ordered\nmodel: fast\napproval_mode: auto\nstarters:\n  - Go\n---\nPrompt.\n",
    );
  });

  it("keeps the prompt exactly, minus leading blank lines and trailing whitespace", () => {
    const def = parsed(file("name: A", "\n\n  first line keeps its indent\nsecond  \n\n"));
    expect(def.prompt).toBe("  first line keeps its indent\nsecond");
  });

  it("treats a missing trailing newline after the closing delimiter as an empty prompt", () => {
    expect(parsed("---\nname: A\n---")).toEqual({ frontmatter: { name: "A" }, prompt: "" });
  });
});

describe("schema rejections", () => {
  it.each([
    ["no frontmatter", "Just a prompt.\n"],
    ["unterminated frontmatter", "---\nname: A\nPrompt.\n"],
    ["empty frontmatter", "---\n---\nPrompt.\n"],
    ["frontmatter that is a list", file("- name: A")],
    ["frontmatter that is a scalar", file("just text")],
  ])("%s", (_name, text) => {
    expect(issuesOf(text).length).toBeGreaterThan(0);
  });

  it("requires a non-empty name", () => {
    expect(issuesOf(file("role: Nameless"))).toEqual([expect.stringMatching(/^frontmatter\.name/)]);
    expect(issuesOf(file('name: "   "'))[0]).toMatch(/^frontmatter\.name/);
  });

  it("rejects unknown keys (strict schema), including YAML merge keys", () => {
    expect(issuesOf(file("name: A\nsystem_prompt: sneaky"))[0]).toMatch(/system_prompt/);
    expect(issuesOf(file("name: A\ntools: { allow: [x], ask: [y] }"))[0]).toMatch(/ask/);
    expect(issuesOf(file("name: A\n<<: { model: smart }"))[0]).toMatch(/<</);
  });

  it.each([
    ["approval_mode outside D29", "approval_mode: bypass", "approval_mode"],
    ["a non-string name", "name: [A]", "name"],
    ["a numeric model", "model: 42", "model"],
    ["a model with spaces", "model: my model", "model"],
    ["a skill slug with uppercase", "skills: [Docx]", "skills"],
    ["a connector with a path", "connectors: [../etc]", "connectors"],
    ["duplicate skills", "skills: [docx, docx]", "skills"],
    ["duplicate connectors", "connectors: [jira, jira]", "connectors"],
    ["a tool glob with a newline", 'tools: { deny: ["a\\nb"] }', "tools.deny"],
    ["a tool glob with a trailing escape", 'tools: { allow: ["mcp__*\\\\"] }', "tools.allow"],
    ["a connector name with a double separator", "connectors: [my__jira]", "connectors"],
    ["an empty starter", 'starters: [""]', "starters"],
    ["an icon URL", "icon: https://evil.example/x.png", "icon"],
    ["a NUL inside a quoted string", 'role: "a\\x00b"', "role"],
    ["a control character in a name", 'name: "a\\u0007"', "name"],
    ["skills as a number", "skills: 3", "skills"],
  ])("rejects %s", (_name, line, path) => {
    const text = line.startsWith("name:") ? file(line) : file(`name: A\n${line}`);
    expect(issuesOf(text).some((i) => i.startsWith(`frontmatter.${path}`))).toBe(true);
  });

  it("enforces list and string lengths", () => {
    const tooMany = Array.from({ length: AGENT_FILE_LIMITS.starters + 1 }, (_, i) => `s${i}`);
    expect(issuesOf(file(`name: A\nstarters: [${tooMany.join(", ")}]`))[0]).toMatch(
      /^frontmatter\.starters/,
    );
    expect(issuesOf(file(`name: ${"n".repeat(AGENT_FILE_LIMITS.name + 1)}`))[0]).toMatch(
      /^frontmatter\.name/,
    );
  });
});

describe("unsafe YAML is refused", () => {
  it.each([
    ["anchors and aliases", "name: &n A\nrole: *n"],
    ["an alias bomb", 'name: A\nrole: &a ["x","x"]\ndescription: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]'],
    ["explicit standard tags", "name: !!str A"],
    ["custom tags", "name: !js/function 'function(){}'"],
    ["duplicate keys", "name: A\nname: B"],
    ["non-string keys", "name: A\n? [x]\n: y"],
    ["content after a document end marker", "name: A\n...\nrole: B"],
  ])("%s", (_name, frontmatter) => {
    expect(issuesOf(file(frontmatter)).length).toBeGreaterThan(0);
  });

  it("refuses control characters anywhere in the file (Postgres text can't hold NUL)", () => {
    expect(issuesOf(file("name: A", "prompt with \u0000 NUL"))[0]).toMatch(/control character/);
    expect(issuesOf(file("name: A", "bell \u0007"))[0]).toMatch(/control character/);
    expect(issuesOf(file("name: A", "lone \uD800 surrogate"))[0]).toMatch(/invalid Unicode/);
    expect(issuesOf(file('name: "a\\uD800b"'))[0]).toMatch(/^frontmatter\.name/);
    expect(validateAgentDefinition({ frontmatter: { name: "A" }, prompt: "\uDC00" }).ok).toBe(
      false,
    );
    expect(parsed(file("name: A", "pair 😀 ok")).prompt).toBe("pair 😀 ok");
    // Tabs and newlines are fine.
    expect(parsed(file("name: A", "a\tb\nc")).prompt).toBe("a\tb\nc");
  });
});

describe("size limits", () => {
  it("rejects a file over the byte limit before parsing", () => {
    const big = file("name: A", "x".repeat(AGENT_FILE_LIMITS.fileBytes));
    expect(issuesOf(big)[0]).toMatch(/too large/);
  });

  it("rejects a prompt over its byte limit, counting UTF-8 bytes", () => {
    // 3 bytes per character: within the file limit, over the prompt limit.
    const prompt = "€".repeat(Math.floor(AGENT_FILE_LIMITS.promptBytes / 3) + 1);
    expect(issuesOf(file("name: A", prompt))[0]).toMatch(/^prompt/);
  });

  it("rejects oversized frontmatter", () => {
    const deny = Array.from({ length: 100 }, (_, i) => `"${String(i).padStart(200, "g")}"`);
    expect(issuesOf(file(`name: A\ntools: { deny: [${deny.join(",")}] }`))[0]).toMatch(
      /frontmatter/,
    );
  });

  it("accepts a prompt at exactly the limit", () => {
    const def = parsed(file("name: A", "p".repeat(AGENT_FILE_LIMITS.promptBytes)));
    expect(def.prompt.length).toBe(AGENT_FILE_LIMITS.promptBytes);
  });
});

describe("validateAgentDefinition (JSON input from the API)", () => {
  it("accepts a definition and normalizes it like an import", () => {
    const result = validateAgentDefinition({
      frontmatter: { name: "  Spaced  ", skills: "exclusive" },
      prompt: "\n\nHello  \n",
    });
    expect(result).toEqual({
      ok: true,
      definition: { frontmatter: { name: "Spaced", skills: { exclusive: [] } }, prompt: "Hello" },
    });
  });

  it("applies the same schema and limits as the file", () => {
    for (const input of [
      null,
      { frontmatter: { name: "A" } },
      { frontmatter: { name: "A", extra: 1 }, prompt: "" },
      { frontmatter: { name: "A" }, prompt: "x\u0000" },
      { frontmatter: { name: "A" }, prompt: "p".repeat(AGENT_FILE_LIMITS.promptBytes + 1) },
      { frontmatter: { name: "A" }, prompt: "", extra: true },
    ]) {
      expect(validateAgentDefinition(input).ok).toBe(false);
    }
  });

  it("produces definitions whose export re-imports identically", () => {
    const result = validateAgentDefinition({
      frontmatter: { name: "API", starters: ["one: two", "three"], tools: { allow: ["mcp__*"] } },
      prompt: "Line 1\n---\nLine 3",
    });
    if (!result.ok) throw new Error("expected ok");
    expect(parsed(serializeAgentFile(result.definition))).toEqual(result.definition);
  });
});

describe("helpers", () => {
  it("agentSkills reads the three skills forms (D22)", () => {
    expect(agentSkills({ name: "A" })).toEqual({ names: [], exclusive: false });
    expect(agentSkills({ name: "A", skills: ["docx"] })).toEqual({
      names: ["docx"],
      exclusive: false,
    });
    expect(agentSkills({ name: "A", skills: { exclusive: ["pdf"] } })).toEqual({
      names: ["pdf"],
      exclusive: true,
    });
  });

  it("slugFromName derives a valid slug", () => {
    expect(slugFromName("Release Notes Writer")).toBe("release-notes-writer");
    expect(slugFromName("  Ünïcödé -- Agent!! ")).toBe("unicode-agent");
    expect(slugFromName("助手")).toBe("agent");
    expect(slugFromName("x".repeat(100))).toHaveLength(48);
    expect(slugFromName(`${"a".repeat(47)}-b`)).toBe("a".repeat(47));
  });
});

describe("agentWarnings (non-blocking; policy is enforced at run time, KOBE-35/47)", () => {
  it("warns about an allow-everything glob and auto approval mode", () => {
    const warnings = agentWarnings({
      name: "A",
      tools: { allow: ["read_file", "*"] },
      approval_mode: "auto",
    });
    expect(warnings.map((w) => w.path)).toEqual([
      "frontmatter.tools.allow.1",
      "frontmatter.approval_mode",
    ]);
    expect(agentWarnings({ name: "A", tools: { allow: ["**"] } })).toHaveLength(1);
  });

  it("is quiet for narrow allows and stricter modes", () => {
    expect(
      agentWarnings({
        name: "A",
        tools: { allow: ["mcp__jira__*"], deny: ["*"] },
        approval_mode: "ask-all",
      }),
    ).toEqual([]);
  });
});
