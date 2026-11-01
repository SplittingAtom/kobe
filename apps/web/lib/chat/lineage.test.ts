import { describe, expect, it } from "vitest";
import {
  familyItems,
  forksLabel,
  hasLineage,
  lineageRows,
  readThreadLineage,
  siblingLabel,
} from "./lineage";
import { SELF, ancestor, lineageOf, relative, tid } from "./testing/lineage-fixtures";

/** KOBE-535 (TL3): the strip's rows, fold and labels from a lineage answer. */
describe("lineageRows", () => {
  it("shows nothing for an ordinary thread", () => {
    expect(hasLineage(lineageOf())).toBe(false);
    expect(lineageRows(lineageOf())).toEqual([]);
  });

  it("is root first, one step deeper per row, the thread on screen last", () => {
    const rows = lineageRows(lineageOf({ ancestors: [ancestor(1, "Budget"), ancestor(2, null)] }));
    expect(rows.map((r) => [r.kind, r.depth])).toEqual([
      ["ancestor", 0],
      ["ancestor", 1],
      ["self", 2],
    ]);
    expect(rows[1]).toMatchObject({ thread: { title: "Untitled conversation" } });
    expect(rows[2]).toMatchObject({ kind: "self", forkedAt: "e-fork", siblings: null });
  });

  it("makes a row with siblings a choice, the root never", () => {
    const sibs = [relative(3, "C"), relative(2, "B"), relative(4, "A")];
    const rows = lineageRows(
      lineageOf({ ancestors: [ancestor(1, "Root", sibs), ancestor(2, "B", sibs, { more: true })] }),
    );
    expect(rows[0]).toMatchObject({ kind: "ancestor", siblings: null });
    const second = rows[1];
    expect(second?.kind === "ancestor" && second.siblings).toMatchObject({
      position: 2,
      total: "50+",
    });
  });

  it("folds more than four ancestor rows: root, the middle, parent, self", () => {
    const ancestors = [1, 2, 3, 4, 5].map((n) => ancestor(n, `Gen ${n}`));
    const rows = lineageRows(lineageOf({ ancestors }));
    expect(rows.map((r) => r.kind)).toEqual(["ancestor", "fold", "ancestor", "self"]);
    const fold = rows[1];
    expect(fold?.kind === "fold" && fold.folded.map((t) => t.title)).toEqual([
      "Gen 2",
      "Gen 3",
      "Gen 4",
    ]);
    expect(lineageRows(lineageOf({ ancestors: ancestors.slice(0, 4) })).map((r) => r.kind)).toEqual(
      ["ancestor", "ancestor", "ancestor", "ancestor", "self"],
    );
  });

  it("puts the hidden root first and the forks last", () => {
    const rows = lineageRows(lineageOf({ rootHidden: true, forks: [relative(7, "F", true)] }));
    expect(rows.map((r) => r.kind)).toEqual(["hidden", "self", "forks"]);
    expect(rows[2]).toMatchObject({ depth: 2, forks: [{ title: "F", inTrash: true }] });
  });
});

describe("labels", () => {
  it("counts siblings and forks, a cut list as 50+", () => {
    expect(siblingLabel("B", { items: [], position: 2, total: "3" })).toBe("B · 2 of 3");
    expect(forksLabel(2, false)).toBe("2 forks");
    expect(forksLabel(50, true)).toBe("50+ forks");
  });

  it("lists the whole family for the phone line, in order", () => {
    const sibs = [relative(5, "Other"), relative(2, "Mid")];
    const { items, related } = familyItems(
      lineageOf({
        rootHidden: true,
        ancestors: [ancestor(1, "Root"), ancestor(2, "Mid", sibs)],
        forks: [relative(8, "Child")],
      }),
    );
    expect(items.map((i) => [i.thread?.title ?? null, i.depth, i.inPath, i.current])).toEqual([
      [null, 0, false, false],
      ["Root", 1, true, false],
      ["Other", 2, false, false],
      ["Mid", 2, true, false],
      ["Try the Q3 numbers", 3, true, true],
      ["Child", 4, false, false],
    ]);
    expect(related).toBe("4");
  });
});

describe("readThreadLineage", () => {
  const answering =
    (status: number, body: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it("validates the answer as sent and sends the team header", async () => {
    let seen: Headers | undefined;
    const body = lineageOf({ ancestors: [ancestor(1, "Root")] });
    const read = await readThreadLineage(SELF, "team-1", async (url, init) => {
      expect(url).toBe(`/v1/threads/${SELF}/lineage`);
      seen = new Headers(init?.headers);
      return answering(200, body)("");
    });
    expect(read).toEqual(body);
    expect(seen?.get("x-kobe-team")).toBe("team-1");
  });

  it("is null for a refusal, a bad body, another thread or no network", async () => {
    expect(await readThreadLineage(SELF, "t", answering(404, { code: "thread_not_found" }))).toBe(
      null,
    );
    expect(await readThreadLineage(SELF, "t", answering(200, { ancestors: "<b>" }))).toBe(null);
    expect(await readThreadLineage(tid(5), "t", answering(200, lineageOf()))).toBe(null);
    expect(
      await readThreadLineage(SELF, "t", async () => {
        throw new TypeError("offline");
      }),
    ).toBe(null);
  });
});
