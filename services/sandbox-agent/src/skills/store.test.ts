import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillBundleRef } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goodBundle, sha256, testZip } from "../testing/zip.js";
import { SkillError, SkillStore } from "./store.js";

let root: string;
let served: Map<string, Uint8Array>;
let fetched: string[];

beforeEach(async () => {
  root = path.join(await mkdtemp(path.join(tmpdir(), "kobe-skills-")), "skills");
  served = new Map();
  fetched = [];
});
afterEach(() => rm(path.dirname(root), { recursive: true, force: true }));

const store = () =>
  new SkillStore({
    root,
    identities: false,
    fetch: (hash) => {
      fetched.push(hash);
      const bytes = served.get(hash);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error("404"));
    },
  });

/** Registers a bundle with the fake server under its real hash; returns its ref. */
function offer(name: string, zip: Uint8Array = goodBundle(), claimed?: Partial<SkillBundleRef>) {
  const hash = sha256(zip);
  served.set(claimed?.sha256 ?? hash, zip);
  return { name, sha256: hash, size: zip.length, ...claimed } satisfies SkillBundleRef;
}
const bundleOf = (n: string) => goodBundle([{ name: `note-${n}.md`, data: n }]);
const dirs = async () => (await readdir(root)).sort();

describe("SkillStore.prepare", () => {
  it("extracts a verified bundle and returns its directory", async () => {
    const ref = offer("demo");
    const [dir] = await store().prepare("t1", [ref]);
    expect(dir).toBe(path.join(root, `sk-${ref.sha256}`));
    expect(await readFile(path.join(dir ?? "", "SKILL.md"), "utf8")).toContain("name: demo");
    expect(await readFile(path.join(dir ?? "", "scripts/run.sh"), "utf8")).toBe("echo hi\n");
  });

  it("rejects bytes whose SHA-256 differs from the server's, leaving nothing behind", async () => {
    const ref = offer("demo");
    served.set(ref.sha256, bundleOf("tampered")); // same size is not enough: the hash decides
    const evil = bundleOf("tampered");
    await expect(store().prepare("t1", [{ ...ref, size: evil.length }])).rejects.toThrow(/SHA-256/);
    expect(await dirs()).toEqual([]);
  });

  it("rejects a bundle whose size differs from the listed size", async () => {
    const ref = offer("demo");
    await expect(store().prepare("t1", [{ ...ref, size: ref.size + 1 }])).rejects.toThrow(/size/);
    expect(await dirs()).toEqual([]);
  });

  it.each([
    [
      "a traversal path",
      [
        { name: "SKILL.md", data: "x" },
        { name: "../../evil", data: "x" },
      ],
    ],
    [
      "a symlink",
      [
        { name: "SKILL.md", data: "x" },
        { name: "l", data: "/etc/passwd", mode: 0o120777 },
      ],
    ],
    [
      "a device node",
      [
        { name: "SKILL.md", data: "x" },
        { name: "d", mode: 0o020666 },
      ],
    ],
    ["no SKILL.md", [{ name: "other.md", data: "x" }]],
    ["a compressed entry", [{ name: "SKILL.md", data: "x", method: 8 }]],
  ])("rejects an unsafe bundle even with a matching hash: %s", async (_label, entries) => {
    const ref = offer("demo", testZip(entries));
    await expect(store().prepare("t1", [ref])).rejects.toBeInstanceOf(SkillError);
    expect(await dirs()).toEqual([]);
    // Nothing escaped the directory either.
    expect(await readdir(path.dirname(root))).toEqual(["skills"]);
  });

  it("writes files the Pi uids can read but not change (agent-owned, no group/other write)", async () => {
    const ref = offer("demo");
    const before = process.umask(0o077); // the agent's umask: modes must not be inherited
    let dir: string;
    try {
      [dir] = (await store().prepare("t1", [ref])) as [string];
    } finally {
      process.umask(before);
    }
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(d, { withFileTypes: true })) {
        out.push(path.join(d, e.name));
        if (e.isDirectory()) out.push(...(await walk(path.join(d, e.name))));
      }
      return out;
    };
    const all = [dir, ...(await walk(dir))];
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const entry of all) {
      const info = await stat(entry);
      expect(info.uid, entry).toBe(process.getuid?.());
      expect(info.mode & 0o022, `${entry} writable by group/other`).toBe(0);
      expect(info.mode & 0o044, `${entry} readable by group and other`).toBe(0o044);
      if (info.isDirectory()) expect(info.mode & 0o011, entry).toBe(0o011);
    }
  });

  it("removes skills no live thread wants any more, on the next start (no stale skills)", async () => {
    const a = offer("a", bundleOf("a"));
    const b = offer("b", bundleOf("b"));
    const s = store();
    await s.prepare("t1", [a, b]);
    expect(await dirs()).toEqual([`sk-${a.sha256}`, `sk-${b.sha256}`].sort());
    await s.prepare("t1", [b]);
    expect(await dirs()).toEqual([`sk-${b.sha256}`]);
    await s.prepare("t1", []);
    expect(await dirs()).toEqual([]);
  });

  it("keeps what another live thread still uses, and drops it once that thread is released", async () => {
    const a = offer("a", bundleOf("a"));
    const b = offer("b", bundleOf("b"));
    const s = store();
    await s.prepare("t1", [a]);
    await s.prepare("t2", [b]);
    expect(await dirs()).toEqual([`sk-${a.sha256}`, `sk-${b.sha256}`].sort());
    s.release("t1");
    await s.prepare("t2", [b]);
    expect(await dirs()).toEqual([`sk-${b.sha256}`]);
  });

  it("does not download a bundle that is already present", async () => {
    const ref = offer("demo");
    const s = store();
    await s.prepare("t1", [ref]);
    await s.prepare("t1", [ref]);
    expect(fetched).toEqual([ref.sha256]);
  });

  it("fails the start when the server no longer offers a bundle, and leaves no half-written directory", async () => {
    const ref = offer("demo");
    served.clear();
    await expect(store().prepare("t1", [ref])).rejects.toThrow(/could not be fetched/);
    expect(await dirs()).toEqual([]);
  });

  it("refuses duplicate names and an oversized run", async () => {
    const a = offer("same", bundleOf("a"));
    const b = offer("same", bundleOf("b"));
    await expect(store().prepare("t1", [a, b])).rejects.toThrow(/twice/);
    await expect(
      store().prepare("t1", [
        { ...a, size: 90 * 1024 * 1024 },
        { ...b, name: "other", size: 90 * 1024 * 1024 },
      ]),
    ).rejects.toThrow(/too (large|big)/);
  });

  it("serializes concurrent starts without losing either thread's skills", async () => {
    const a = offer("a", bundleOf("a"));
    const b = offer("b", bundleOf("b"));
    const s = store();
    await Promise.all([s.prepare("t1", [a]), s.prepare("t2", [b])]);
    expect(await dirs()).toEqual([`sk-${a.sha256}`, `sk-${b.sha256}`].sort());
  });
});

describe("SkillStore.init", () => {
  it("empties what an earlier agent left (skills and half-extracted temp directories)", async () => {
    await mkdir(path.join(root, `sk-${"a".repeat(64)}`), { recursive: true });
    await mkdir(path.join(root, ".tmp-deadbeef"));
    await writeFile(path.join(root, "unrelated"), "keep");
    await store().init();
    expect(await dirs()).toEqual(["unrelated"]);
  });
});
