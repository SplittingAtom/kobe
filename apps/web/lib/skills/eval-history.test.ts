import { describe, expect, it } from "vitest";
import type { SkillSummary } from "../admin/api/team/skills";
import type { SkillEvalRun } from "./evals-api";
import { mergeEvalHistory, savedSkillsOf } from "./eval-history";

/** KOBE-459 ac-5: one history of the draft's runs and its saved skill's, labelled by source. */
const skill = (over: Partial<SkillSummary>): SkillSummary => ({
  id: "s-1",
  scope: "team",
  slug: "report-writer",
  description: "",
  latestVersion: 2,
  latestSemver: "1.1.0",
  ownerUserId: null,
  createdAt: "x",
  updatedAt: "x",
  ...over,
});
const run = (id: string, startedAt: string, subject: SkillEvalRun["subject"]): SkillEvalRun =>
  ({ id, subject, startedAt }) as unknown as SkillEvalRun;

describe("savedSkillsOf", () => {
  const skills = [
    skill({}),
    skill({ id: "s-2", scope: "personal", ownerUserId: "u-me" }),
    skill({ id: "s-3", slug: "other" }),
  ];

  it("finds the same-named team skill and, for the author, the personal one", () => {
    expect(savedSkillsOf(skills, "report-writer", true).map((s) => s.id)).toEqual(["s-1", "s-2"]);
    // A shared draft's reader: their own personal skill of that name is not this draft's.
    expect(savedSkillsOf(skills, "report-writer", false).map((s) => s.id)).toEqual(["s-1"]);
    expect(savedSkillsOf(skills, "never-saved", true)).toEqual([]);
  });
});

describe("mergeEvalHistory", () => {
  it("lists every run once, newest first, labelled by source; only versions the viewer saved", () => {
    const team = skill({});
    const draftRuns = [
      run("d-2", "2026-10-19T10:00:00Z", { kind: "draft", draftId: "d-1", rev: 4 }),
      run("d-1", "2026-10-17T10:00:00Z", { kind: "draft", draftId: "d-1", rev: 2 }),
    ];
    const skillRuns = [
      run("v-2", "2026-10-18T10:00:00Z", {
        kind: "version",
        scope: "team",
        skillId: "s-1",
        seq: 2,
      }),
      run("v-1", "2026-10-16T10:00:00Z", {
        kind: "version",
        scope: "team",
        skillId: "s-1",
        seq: 1,
      }),
      // Listed twice (a re-read): shown once.
      run("v-1", "2026-10-16T10:00:00Z", {
        kind: "version",
        scope: "team",
        skillId: "s-1",
        seq: 1,
      }),
      // Version 3 was saved by another member: not this draft's.
      run("v-3", "2026-10-20T10:00:00Z", {
        kind: "version",
        scope: "team",
        skillId: "s-1",
        seq: 3,
      }),
    ];
    const versions = [
      { seq: 1, semver: "1.0.0" },
      { seq: 2, semver: "1.1.0" },
    ];
    const rows = mergeEvalHistory(draftRuns, [{ skill: team, runs: skillRuns, versions }]);
    expect(rows.map((r) => [r.run.id, r.source, r.of])).toEqual([
      ["d-2", "This draft", "revision 4"],
      ["v-2", "Team skill report-writer (same name)", "v1.1.0"],
      ["d-1", "This draft", "revision 2"],
      ["v-1", "Team skill report-writer (same name)", "v1.0.0"],
    ]);
  });

  it("labels a personal skill's runs as such", () => {
    const mine = skill({ id: "s-2", scope: "personal" });
    const rows = mergeEvalHistory(
      [],
      [
        {
          skill: mine,
          runs: [
            run("v", "2026-10-18T10:00:00Z", {
              kind: "version",
              scope: "personal",
              skillId: "s-2",
              seq: 2,
            }),
          ],
          versions: [{ seq: 2, semver: "0.2.0" }],
        },
      ],
    );
    expect(rows.map((r) => r.source)).toEqual(["Personal skill report-writer (same name)"]);
  });
});
