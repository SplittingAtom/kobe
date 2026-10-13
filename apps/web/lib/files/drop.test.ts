import { describe, expect, it } from "vitest";
import type { ApiResult } from "../api/client";
import type { FileEntry, FilesApi } from "./api";
import { carriesFiles, copyName, droppedItems, uploadDropped } from "./drop";
import { isDroppedUpload } from "./format";

const fileOf = (name: string) => new File(["x"], name);

function fakeApi(answers: Record<string, ApiResult<FileEntry>>) {
  const calls: { folder: string; name: string }[] = [];
  const api = {
    upload: (folder: string, file: File, name = file.name) => {
      calls.push({ folder, name });
      const ok = { ok: true, status: 201, data: {} as FileEntry } as const;
      return Promise.resolve(answers[name] ?? ok);
    },
  } as unknown as FilesApi;
  return { api, calls };
}

const refused = (status: number, code: string): ApiResult<FileEntry> => ({
  ok: false,
  error: { status, code, message: code },
});

describe("rail drop helpers (KOBE-199)", () => {
  it("names copies after a clash before the extension", () => {
    expect(copyName("report.pdf", 1)).toBe("report (1).pdf");
    expect(copyName("archive.tar.gz", 2)).toBe("archive.tar (2).gz");
    expect(copyName("README", 3)).toBe("README (3)");
    expect(copyName(".env", 1)).toBe(".env (1)");
  });

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

  it("uploads into uploads/, renames on a clash and stops at a full workspace", async () => {
    const { api, calls } = fakeApi({
      "a.txt": refused(409, "already_exists"),
      "c.txt": refused(507, "quota_exceeded"),
    });
    const out = await uploadDropped(api, [
      fileOf("a.txt"),
      fileOf("b.txt"),
      fileOf("c.txt"),
      fileOf("d.txt"),
    ]);
    expect(calls).toEqual([
      { folder: "uploads", name: "a.txt" },
      { folder: "uploads", name: "a (1).txt" },
      { folder: "uploads", name: "b.txt" },
      { folder: "uploads", name: "c.txt" },
    ]);
    expect(out.added).toEqual(["a (1).txt", "b.txt"]);
    expect(out.errors.map((e) => e.message)).toEqual([
      "c.txt: Your workspace is full. Delete something and try again.",
    ]);
  });

  it("gives up after nine copies of one name", async () => {
    const taken = refused(409, "already_exists");
    const { api, calls } = fakeApi(
      Object.fromEntries(
        ["n.txt", ...Array.from({ length: 9 }, (_, i) => `n (${i + 1}).txt`)].map((n) => [
          n,
          taken,
        ]),
      ),
    );
    const out = await uploadDropped(api, [fileOf("n.txt")]);
    expect(calls).toHaveLength(10);
    expect(out.errors[0]?.code).toBe("already_exists");
  });

  it("lets the member delete only their own drops in uploads/", () => {
    expect(isDroppedUpload({ path: "uploads/brief.pdf", type: "file" })).toBe(true);
    expect(isDroppedUpload({ path: "uploads/brief", type: "dir" })).toBe(false);
    expect(isDroppedUpload({ path: "uploads/t/brief.pdf", type: "file" })).toBe(false);
    expect(
      isDroppedUpload({ path: "uploads/0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d", type: "file" }),
    ).toBe(false);
    expect(isDroppedUpload({ path: "projects/brief.pdf", type: "file" })).toBe(false);
  });
});
