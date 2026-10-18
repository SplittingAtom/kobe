import { describe, expect, it, vi } from "vitest";
import { mentionMarker } from "@kobe/protocol";
import {
  ComposerMentionChannel,
  insertMention,
  MENTION_FOLDER_REFUSED,
  MENTION_LIMIT_REFUSED,
  MENTION_NAME_REFUSED,
  MENTION_NO_COMPOSER,
  mentionRefusal,
} from "./mention-insert";
import {
  carriesWorkspaceFolder,
  carriesWorkspaceRow,
  droppedRowPath,
  startRowDrag,
  TREE_DRAG_FOLDER_TYPE,
  TREE_DRAG_TYPE,
} from "../files/drag";

/** KOBE-374 ac-4: a workspace file mentioned from the Files rail, by the KOBE-223 rules. */
describe("mentionRefusal", () => {
  it("takes files anywhere the member can see them, project mounts and uploads included", () => {
    for (const path of ["report.csv", "notes/todo.md", "projects/p1/plan.md", "uploads/a.pdf"]) {
      expect(mentionRefusal(path, "file"), path).toBeUndefined();
    }
  });

  it("refuses folders, .kobe/, and names the server would refuse", () => {
    expect(mentionRefusal("notes", "dir")).toBe(MENTION_FOLDER_REFUSED);
    expect(mentionRefusal(".kobe/sessions/t.jsonl", "file")).toBe(MENTION_NAME_REFUSED);
    expect(mentionRefusal("a​b.txt", "file")).toBe(MENTION_NAME_REFUSED); // zero-width
    expect(mentionRefusal("x‮.txt", "file")).toBe(MENTION_NAME_REFUSED); // bidi override
    expect(mentionRefusal("run;rm.sh", "file")).toBe(MENTION_NAME_REFUSED);
    expect(mentionRefusal("../etc/passwd", "file")).toBe(MENTION_NAME_REFUSED);
  });

  it("caps a message at 20 files, but a file already mentioned may come again", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    expect(mentionRefusal("new.txt", "file", twenty)).toBe(MENTION_LIMIT_REFUSED);
    expect(mentionRefusal("f3.txt", "file", twenty)).toBeUndefined();
    expect(mentionRefusal("new.txt", "file", twenty.slice(1))).toBeUndefined();
  });
});

describe("insertMention", () => {
  const m = mentionMarker("data/x y.csv");

  it("writes the picker's marker at the caret, spaced from the text around it", () => {
    expect(insertMention("", 0, "data/x y.csv")).toEqual({ text: `${m} `, caret: m.length + 1 });
    expect(insertMention("read", 4, "data/x y.csv").text).toBe(`read ${m} `);
    expect(insertMention("read  please", 5, "data/x y.csv").text).toBe(`read ${m} please`);
    const mid = insertMention("read please", 4, "data/x y.csv");
    expect(mid.text).toBe(`read ${m} please`);
    expect(mid.caret).toBe(`read ${m} `.length);
  });

  it("clamps a caret outside the text", () => {
    expect(insertMention("hi", 99, "a.txt").text).toBe(`hi ${mentionMarker("a.txt")} `);
    expect(insertMention("hi", -3, "a.txt").text).toBe(`${mentionMarker("a.txt")} hi`);
  });
});

describe("ComposerMentionChannel", () => {
  it("says there is no composer until one listens; the latest listener takes it", () => {
    const channel = new ComposerMentionChannel();
    expect(channel.request("a.txt")).toBe(MENTION_NO_COMPOSER);
    const first = vi.fn(() => undefined);
    const second = vi.fn(() => "refused");
    const stopFirst = channel.listen(first);
    const stopSecond = channel.listen(second);
    expect(channel.request("a.txt")).toBe("refused");
    expect(first).not.toHaveBeenCalled();
    stopSecond();
    expect(channel.request("b.txt")).toBeUndefined();
    expect(first).toHaveBeenCalledWith("b.txt");
    stopFirst();
    expect(channel.request("c.txt")).toBe(MENTION_NO_COMPOSER);
  });
});

describe("a workspace row's drag", () => {
  const transfer = () => {
    const data = new Map<string, string>();
    return {
      get types() {
        return [...data.keys()];
      },
      setData: (t: string, v: string) => data.set(t, v),
      getData: (t: string) => data.get(t) ?? "",
      effectAllowed: "all",
    } as unknown as DataTransfer;
  };

  it("carries its own types, never Files; a folder says so while hovering", () => {
    const file = transfer();
    startRowDrag(file, { path: "notes/todo.md", type: "file" }, true);
    expect(file.types).toEqual([TREE_DRAG_TYPE]);
    expect(file.effectAllowed).toBe("copyMove");
    expect(carriesWorkspaceRow(file)).toBe(true);
    expect(carriesWorkspaceFolder(file)).toBe(false);
    expect(droppedRowPath(file)).toBe("notes/todo.md");

    const folder = transfer();
    startRowDrag(folder, { path: "notes", type: "dir" }, true);
    expect(folder.types).toEqual([TREE_DRAG_TYPE, TREE_DRAG_FOLDER_TYPE]);
    expect(carriesWorkspaceFolder(folder)).toBe(true);

    // A read-only file is only ever mentioned (copied), never moved.
    const project = transfer();
    startRowDrag(project, { path: "projects/p1/plan.md", type: "file" }, false);
    expect(project.effectAllowed).toBe("copy");

    expect(TREE_DRAG_TYPE).toBe("application/x-kobe-workspace-path");
    expect(carriesWorkspaceRow(null)).toBe(false);
  });
});
