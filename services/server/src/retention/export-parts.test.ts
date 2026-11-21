import { describe, expect, it } from "vitest";
import { jsonArrayEnd, jsonArrayItem, threadIndexEntry, type ThreadRow } from "./export.js";

/** KOBE-730: the pure parts of exportZip. */
describe("export JSON arrays", () => {
  it("writes rows as one valid JSON object, empty or not", () => {
    const open = '{\n  "cases": [';
    expect(JSON.parse(`${open}${jsonArrayEnd(true)}`)).toEqual({ cases: [] });
    const text = `${open}${jsonArrayItem(true, { a: 1 })}${jsonArrayItem(false, { b: 2 })}${jsonArrayEnd(false)}`;
    expect(JSON.parse(text)).toEqual({ cases: [{ a: 1 }, { b: 2 }] });
    expect(text).toBe('{\n  "cases": [\n    {"a":1},\n    {"b":2}\n  ]\n}\n');
  });
});

describe("threadIndexEntry", () => {
  const thread: ThreadRow = {
    id: "t1",
    title: "Revenue",
    leaf_entry_id: null,
    created_at: "2026-11-20T10:00:00.000Z",
    last_activity_at: "2026-11-20T11:00:00.000Z",
    deleted_at: null,
    folder_id: "f1",
  };
  const heading = {
    threadId: "t1",
    title: "Revenue",
    createdAt: "2026-11-20T10:00:00.000Z",
    lastActivityAt: "2026-11-20T11:00:00.000Z",
    inTrash: false,
  };
  const base = {
    thread,
    heading,
    session: "sessions/t1.jsonl",
    transcript: "transcripts/x.md",
    folders: new Map<string, unknown>(),
    labels: [],
    branchFiles: [],
    branchesCapped: false,
  };

  it("lists a straight, unfiled thread with no optional keys", () => {
    expect(threadIndexEntry(base)).toEqual({
      id: "t1",
      title: "Revenue",
      created_at: heading.createdAt,
      last_activity_at: heading.lastActivityAt,
      in_trash: false,
      session: "sessions/t1.jsonl",
      transcript: "transcripts/x.md",
    });
  });

  it("adds the folder path, labels, branch files and the cap only when present", () => {
    const entry = threadIndexEntry({
      ...base,
      folders: new Map([["f1", ["Finance", "Q4"]]]),
      labels: [{ entry_id: "e1", label: "draft" }],
      branchFiles: ["branches/x/1-draft.md"],
      branchesCapped: true,
    });
    expect(entry).toMatchObject({
      folder: ["Finance", "Q4"],
      labels: [{ entry_id: "e1", label: "draft" }],
      branches: ["branches/x/1-draft.md"],
      branches_capped: true,
    });
  });
});
