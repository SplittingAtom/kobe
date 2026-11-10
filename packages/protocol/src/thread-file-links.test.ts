import { describe, expect, it } from "vitest";
import {
  fileThreadsQuerySchema,
  listParameter,
  threadFileLinksQuerySchema,
  threadFileLinksSchema,
} from "./thread-file-links.js";

const ID = "6f1c2b3a-1d2e-4f50-8a9b-0c1d2e3f4a5b";

describe("thread-file links contract (KOBE-611)", () => {
  it("splits a single list value on commas and takes repeated values whole", () => {
    expect(listParameter(["a,b,a"])).toEqual(["a", "b"]);
    expect(listParameter(["a,b.md", "c"])).toEqual(["a,b.md", "c"]);
  });

  it("caps and validates the thread ids and paths", () => {
    expect(threadFileLinksQuerySchema.safeParse({ threads: [ID] }).success).toBe(true);
    expect(threadFileLinksQuerySchema.safeParse({ threads: [] }).success).toBe(false);
    expect(threadFileLinksQuerySchema.safeParse({ threads: ["nope"] }).success).toBe(false);
    expect(
      threadFileLinksQuerySchema.safeParse({ threads: Array.from({ length: 51 }, () => ID) })
        .success,
    ).toBe(false);
    expect(fileThreadsQuerySchema.safeParse({ paths: ["projects/docs/a.md"] }).success).toBe(true);
    for (const bad of ["../x", "/abs", "a//b", ""]) {
      expect(fileThreadsQuerySchema.safeParse({ paths: [bad] }).success, bad).toBe(false);
    }
    expect(
      fileThreadsQuerySchema.safeParse({ paths: Array.from({ length: 101 }, (_, i) => `f${i}`) })
        .success,
    ).toBe(false);
  });

  it("describes a thread's files strictly", () => {
    const file = {
      path: "notes/a.md",
      project_id: null,
      access: "write",
      last_at: "2026-11-01T10:00:00.000Z",
      deleted: false,
    };
    expect(
      threadFileLinksSchema.safeParse({ thread_id: ID, files: [file], hidden_count: 2 }).success,
    ).toBe(true);
    expect(
      threadFileLinksSchema.safeParse({
        thread_id: ID,
        files: [{ ...file, access: "execute" }],
        hidden_count: 0,
      }).success,
    ).toBe(false);
    expect(
      threadFileLinksSchema.safeParse({ thread_id: ID, files: [], hidden_count: -1 }).success,
    ).toBe(false);
  });
});
