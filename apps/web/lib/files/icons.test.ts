import { FileCodeIcon, FileIcon, FolderIcon, FolderLockIcon, FolderOpenIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { FILE_KIND_LABELS, FILE_KINDS, fileKind, fileKindIcon, folderIcon } from "./icons";

describe("file-type icons (KOBE-304, ac-3)", () => {
  it.each([
    ["app.ts", "code"],
    ["App.TSX", "code"],
    ["main.py", "code"],
    ["server.go", "code"],
    ["lib.rs", "code"],
    ["query.sql", "code"],
    ["Dockerfile", "code"],
    ["Makefile", "code"],
    ["deploy.sh", "shell"],
    ["data.json", "json"],
    ["events.jsonl", "json"],
    ["values.yaml", "config"],
    ["ci.yml", "config"],
    ["pyproject.toml", "config"],
    [".env", "config"],
    [".env.local", "config"],
    [".gitignore", "config"],
    ["README.md", "markdown"],
    ["notes.txt", "text"],
    ["README", "text"],
    ["report.pdf", "pdf"],
    ["sales.csv", "spreadsheet"],
    ["sales.xlsx", "spreadsheet"],
    ["events.parquet", "spreadsheet"],
    ["letter.docx", "document"],
    ["deck.pptx", "presentation"],
    ["photo.jpeg", "image"],
    ["logo.svg", "image"],
    ["voice.mp3", "audio"],
    ["clip.mp4", "video"],
    ["bundle.zip", "archive"],
    ["backup.tar.gz", "archive"],
    ["site.tgz", "archive"],
    ["index.html", "html"],
    ["analysis.ipynb", "notebook"],
    ["unknown.xyz", "file"],
    ["noextension", "file"],
  ] as const)("%s is %s", (name, kind) => {
    expect(fileKind(name)).toBe(kind);
  });

  it("falls back to the MIME type only when the name says nothing", () => {
    expect(fileKind("scan", "application/pdf")).toBe("pdf");
    expect(fileKind("blob", "image/png")).toBe("image");
    expect(fileKind("blob", "text/plain; charset=utf-8")).toBe("text");
    expect(
      fileKind("blob", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe("spreadsheet");
    expect(fileKind("blob", "application/octet-stream")).toBe("file");
    expect(fileKind("app.ts", "image/png")).toBe("code"); // the name wins
  });

  it("gives every kind an icon and words; unknown files get the generic icon", () => {
    for (const kind of FILE_KINDS) {
      expect(fileKindIcon(kind)).toBeTruthy();
      expect(FILE_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
    expect(fileKindIcon("file")).toBe(FileIcon);
    expect(fileKindIcon("code")).toBe(FileCodeIcon);
  });

  it("folders open and close; a read-only one carries a lock", () => {
    expect(folderIcon(false, false)).toBe(FolderIcon);
    expect(folderIcon(true, false)).toBe(FolderOpenIcon);
    expect(folderIcon(true, true)).toBe(FolderLockIcon);
  });
});
