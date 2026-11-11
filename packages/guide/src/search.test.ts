import { describe, expect, it } from "vitest";
import { buildGuide } from "./loader.js";
import { pageHeadings, searchGuide, SEARCH_MAX_RESULTS } from "./search.js";

/** KOBE-620 (KA-3): docs_search over titles, summaries and headings, ranked and capped. */

const fm = (title: string, summary: string, section = "Memory") =>
  `---\ntitle: ${title}\nsummary: ${summary}\nsection: ${section}\n---\n`;

const PAGES = buildGuide([
  {
    path: "memory.md",
    content: `${fm("Memory", "What Kobe remembers about you.")}\n## Turn memory off\n\nText.\n\n\`\`\`md\n## Not a heading\n\`\`\`\n\n### Forget one item\n`,
  },
  {
    path: "admin/team-members.md",
    content: `${fm("Team members", "Invite people and change roles.", "Team admin")}\n## Change a member's role\n`,
  },
  {
    path: "models.md",
    content: `${fm("Models", "Pick a model; memory use differs.", "Models")}\nText.\n`,
  },
]);
const ORIGIN = "https://kobe.example.com";

describe("pageHeadings", () => {
  it("lists h2-h4 outside code fences, with their anchors", () => {
    expect(pageHeadings(PAGES.find((p) => p.slug === "memory") as (typeof PAGES)[number])).toEqual([
      { level: 2, text: "Turn memory off", id: "turn-memory-off" },
      { level: 3, text: "Forget one item", id: "forget-one-item" },
    ]);
  });
});

describe("searchGuide", () => {
  it("ranks title over heading over summary matches", () => {
    const hits = searchGuide(PAGES, "memory", ORIGIN);
    expect(hits.map((h) => h.slug)).toEqual(["memory", "models"]);
    expect(hits[0]).toMatchObject({
      title: "Memory",
      url: `${ORIGIN}/docs/memory.md`,
      section: "Memory",
    });
    expect(hits[0]?.headings).toEqual([
      { text: "Turn memory off", url: `${ORIGIN}/docs/memory#turn-memory-off` },
    ]);
  });

  it("matches every word, case-insensitively, in any field", () => {
    expect(searchGuide(PAGES, "CHANGE role", ORIGIN).map((h) => h.slug)).toEqual([
      "admin/team-members",
    ]);
    expect(searchGuide(PAGES, "role nothing-like-this", ORIGIN)).toEqual([]);
  });

  it("returns nothing for an empty query and caps the results", () => {
    expect(searchGuide(PAGES, "   ", ORIGIN)).toEqual([]);
    const many = buildGuide(
      Array.from({ length: 30 }, (_, i) => ({ path: `p${i}.md`, content: fm(`Page ${i}`, "S.") })),
    );
    expect(searchGuide(many, "page", ORIGIN)).toHaveLength(SEARCH_MAX_RESULTS);
    expect(searchGuide(many, "page", ORIGIN, 3)).toHaveLength(3);
  });
});
