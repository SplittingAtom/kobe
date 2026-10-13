import { describe, expect, it } from "vitest";
import type { ApiResult } from "../api/client";
import type { FileEntry, FilesApi } from "./api";
import { carriesFiles, droppedItems, uploadDropped } from "./drop";
import { isReadOnlyPath } from "./format";

const fileOf = (name: string) => new File(["x"], name);

function fakeApi(answers: Record<string, ApiResult<FileEntry>>) {
  const calls: { folder: string; name: string }[] = [];
  const api = {
    upload: (folder: string, file: File) => {
      calls.push({ folder, name: file.name });
      // The server names a clash's copy; the client only reports what it chose.
      const ok = { ok: true, status: 201, data: { name: `${file.name}!` } as FileEntry } as const;
      return Promise.resolve(answers[file.name] ?? ok);
    },
  } as unknown as FilesApi;
  return { api, calls };
}

const refused = (status: number, code: string): ApiResult<FileEntry> => ({
  ok: false,
  error: { status, code, message: code },
});

describe("rail drop helpers (KOBE-199)", () => {
  it("knows a file drag from a text drag", () => {
    expect(carriesFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(carriesFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });

  it("reads files without items (older browsers) and sorts folders out of items", () => {
    const a = fileOf("a.txt");
    expect(droppedItems({ files: [a] } as unknown as DataTransfer)).toEqual({
      files: [a],
      folders: [],
    });
    const dt = {
      files: [a],
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => a, webkitGetAsEntry: () => ({ isDirectory: false }) },
        {
          kind: "file",
          getAsFile: () => null,
          webkitGetAsEntry: () => ({ isDirectory: true, name: "pics" }),
        },
      ],
    } as unknown as DataTransfer;
    expect(droppedItems(dt)).toEqual({ files: [a], folders: ["pics"] });
  });

  it("uploads each file once into uploads/, reports the server's names, stops at a full workspace", async () => {
    const { api, calls } = fakeApi({
      "b.txt": refused(413, "file_too_large"),
      "c.txt": refused(507, "quota_exceeded"),
    });
    const out = await uploadDropped(api, ["a.txt", "b.txt", "c.txt", "d.txt"].map(fileOf));
    expect(calls).toEqual([
      { folder: "uploads", name: "a.txt" },
      { folder: "uploads", name: "b.txt" },
      { folder: "uploads", name: "c.txt" },
    ]);
    expect(out.added).toEqual(["a.txt!"]);
    expect(out.errors.map((e) => e.message)).toEqual([
      "b.txt: That file is too large to upload. file_too_large",
      "c.txt: Your workspace is full. Delete something and try again.",
    ]);
  });

  it("lets the member change only their own drops in uploads/", () => {
    expect(isReadOnlyPath("uploads/brief.pdf")).toBe(false);
    expect(isReadOnlyPath("uploads")).toBe(true);
    expect(isReadOnlyPath("uploads/t/brief.pdf")).toBe(true);
    expect(isReadOnlyPath("uploads/0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d")).toBe(true);
    expect(isReadOnlyPath("projects/brief.pdf")).toBe(true);
    expect(isReadOnlyPath("notes/brief.pdf")).toBe(false);
  });
});
