import { constants, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OffVolumeError, openOnVolume, shareOnVolume } from "./volume.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobe-volume-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A directory on another filesystem than the temp dir (Linux: /dev/shm), when there is one. */
const otherVolume =
  existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync(tmpdir()).dev
    ? "/dev/shm"
    : undefined;

describe("workspace volume guard (KOBE-71)", () => {
  it("opens files on the volume", async () => {
    await writeFile(path.join(root, "f"), "x");
    const handle = await openOnVolume(root, path.join(root, "f"), constants.O_RDONLY);
    expect((await handle.readFile()).toString()).toBe("x");
    await handle.close();
  });

  it("never opens through a final symlink", async () => {
    await writeFile(path.join(root, "target"), "x");
    await symlink(path.join(root, "target"), path.join(root, "link"));
    await expect(openOnVolume(root, path.join(root, "link"), constants.O_RDONLY)).rejects.toThrow();
  });

  it.runIf(otherVolume !== undefined)(
    "refuses a file a replaced parent leads off the volume (another Pi's dir, the token)",
    async () => {
      const elsewhere = await mkdtemp(path.join(otherVolume as string, "kobe-volume-"));
      try {
        await writeFile(path.join(elsewhere, "model.json"), "secret");
        // The race this guards against, made permanent: the parent is a link off the volume.
        await symlink(elsewhere, path.join(root, "swapped"));
        const file = path.join(root, "swapped", "model.json");
        await expect(openOnVolume(root, file, constants.O_RDONLY)).rejects.toThrow(OffVolumeError);
        await expect(
          openOnVolume(
            root,
            path.join(root, "swapped", "new"),
            constants.O_WRONLY | constants.O_CREAT,
          ),
        ).rejects.toThrow(OffVolumeError);
        expect(await readFile(path.join(elsewhere, "model.json"), "utf8")).toBe("secret");
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    },
  );

  it("gives directories and files the agent owns the shared-group mode, through a handle", async () => {
    await mkdir(path.join(root, "d"), { mode: 0o700 });
    await writeFile(path.join(root, "d", "s.jsonl"), "x", { mode: 0o600 });
    await shareOnVolume(root, path.join(root, "d"), 0o770);
    await shareOnVolume(root, path.join(root, "d", "s.jsonl"), 0o660);
    expect((await stat(path.join(root, "d"))).mode & 0o777).toBe(0o770);
    expect((await stat(path.join(root, "d", "s.jsonl"))).mode & 0o777).toBe(0o660);
    // A link or a missing path is left alone (no throw).
    await symlink(path.join(root, "d"), path.join(root, "l"));
    await shareOnVolume(root, path.join(root, "l"), 0o777);
    await shareOnVolume(root, path.join(root, "missing"), 0o777);
    expect((await stat(path.join(root, "d"))).mode & 0o777).toBe(0o770);
  });
});
