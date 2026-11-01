import { describe, expect, it } from "vitest";
import { LINEAGE_MAX_SIBLINGS, threadLineageResponseSchema } from "@kobe/protocol";
import { assembleLineage, capList, type LineageMember } from "./lineage.js";

/** The pure half of the lineage read (KOBE-533): caps and assembly; the db test covers the SQL. */
const viewer = { teamId: "t", userId: "me", projectIds: [] };
let seq = 0;
const member = (over: Partial<LineageMember> = {}): LineageMember => {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    title: `t${seq}`,
    deletedAt: null,
    ownerUserId: "me",
    forkedFromThreadId: null,
    ...over,
  };
};

describe("capList", () => {
  const many = Array.from({ length: LINEAGE_MAX_SIBLINGS + 3 }, () => member());

  it("keeps a short list whole", () => {
    expect(capList(many.slice(0, 3))).toEqual({ list: many.slice(0, 3), more: false });
  });

  it("cuts a long list and says so", () => {
    const cut = capList(many);
    expect(cut.list).toHaveLength(LINEAGE_MAX_SIBLINGS);
    expect(cut.more).toBe(true);
  });

  it("keeps the thread on the path in, last, when it falls past the cut", () => {
    const keep = many.at(-1) as LineageMember;
    const cut = capList(many, keep);
    expect(cut.list).toHaveLength(LINEAGE_MAX_SIBLINGS);
    expect(cut.list.at(-1)).toBe(keep);
    expect(cut.list.slice(0, -1)).toEqual(many.slice(0, LINEAGE_MAX_SIBLINGS - 1));
  });
});

describe("assembleLineage", () => {
  it("builds a schema-valid answer: root first, siblings from the parent's forks", () => {
    const root = member({ title: null });
    const a = member({ forkedFromThreadId: root.id });
    const b = member({ forkedFromThreadId: root.id, ownerUserId: "other" });
    const self = member({ forkedFromThreadId: a.id, deletedAt: new Date(0) });
    const fork = member({ forkedFromThreadId: self.id, ownerUserId: "other" });
    const body = assembleLineage({
      viewer,
      self,
      forkedAtEntryId: "e1",
      path: [a, root],
      rootHidden: false,
      forks: new Map([
        [root.id, [b, a]],
        [a.id, [self]],
        [self.id, [fork]],
      ]),
    });
    expect(threadLineageResponseSchema.parse(body)).toEqual(body);
    expect(body.ancestors.map((x) => x.thread_id)).toEqual([root.id, a.id]);
    expect(body.ancestors[0]).toMatchObject({ title: null, siblings: [], siblings_more: false });
    expect(body.ancestors[1]?.siblings.map((x) => [x.thread_id, x.owner])).toEqual([
      [b.id, "other"],
      [a.id, "me"],
    ]);
    expect(body.self.siblings.map((x) => x.deleted_at)).toEqual([new Date(0).toISOString()]);
    expect(body.forks).toEqual([
      { thread_id: fork.id, title: fork.title, deleted_at: null, owner: "other" },
    ]);
  });

  it("gives the topmost readable thread no siblings when the root is hidden", () => {
    const self = member({ forkedFromThreadId: "hidden" });
    const body = assembleLineage({
      viewer,
      self,
      forkedAtEntryId: "e1",
      path: [],
      rootHidden: true,
      forks: new Map([["hidden", [self, member()]]]),
    });
    expect(body).toMatchObject({ root_hidden: true, ancestors: [], forks: [] });
    expect(body.self.siblings).toEqual([]);
  });
});
