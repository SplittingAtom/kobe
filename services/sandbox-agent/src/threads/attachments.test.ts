import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AttachmentPathError, confineAttachment, promptWithAttachments } from "./attachments.js";

let root: string;
let outside: string;
beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "kobe-att-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "secret"), "x");
  await writeFile(path.join(root, "uploads", "ok.txt"), "x");
});

describe("confineAttachment", () => {
  it("accepts a file in the workspace and one not synced yet", async () => {
    const ok = await confineAttachment(root, path.join(root, "uploads", "ok.txt"));
    expect(ok).toMatchObject({ exists: true, size: 1 });
    const later = await confineAttachment(root, path.join(root, "uploads", "t", "new.txt"));
    expect(later.exists).toBe(false);
  });

  it.each([
    ["relative", () => "uploads/ok.txt"],
    ["outside", () => "/etc/passwd"],
    ["dotdot", () => `${root}/uploads/../../outside/secret`],
    ["sibling prefix", () => `${root}-evil/x`],
    ["control char", () => `${root}/uploads/a\nb`],
    ["the root", () => root],
  ])("refuses %s", async (_name, input) => {
    await expect(confineAttachment(root, input())).rejects.toBeInstanceOf(AttachmentPathError);
  });

  it("refuses symlinks to outside, inside and dangling, and a symlinked directory", async () => {
    await symlink(path.join(outside, "secret"), path.join(root, "uploads", "out"));
    await symlink(path.join(root, "uploads", "ok.txt"), path.join(root, "uploads", "in"));
    await symlink(path.join(outside, "none"), path.join(root, "uploads", "dangling"));
    await symlink(outside, path.join(root, "uploads", "dir"));
    for (const p of ["out", "in", "dangling", "dir/secret", "dir/new-file"]) {
      await expect(
        confineAttachment(root, path.join(root, "uploads", p)),
        p,
      ).rejects.toBeInstanceOf(AttachmentPathError);
    }
  });

  it("refuses a directory", async () => {
    await expect(confineAttachment(root, path.join(root, "uploads"))).rejects.toBeInstanceOf(
      AttachmentPathError,
    );
  });
});

describe("promptWithAttachments", () => {
  it("returns the message alone without attachments", () => {
    expect(promptWithAttachments("hi", [], new Set())).toBe("hi");
  });
});
