import { spawn } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPiIdentities,
  partnerOf,
  type PiIdentities,
  type PiIdentity,
} from "../pi/identities.js";
import { ensureParents, lockServerOwned, writeFileAtomic } from "./fs.js";

/**
 * Project files are read-only to tools by uid permissions (KOBE-162, ac-1), with the real helper.
 * Same setup and skip rule as identities.partner.real.test.ts (scripts/test-identities.sh): the
 * agent's uid owns `projects/`, the Pi uid (executor off: Pi's own tools) and the partner uid
 * (executor on) hold only the workspace group, the shared workspace root is group-writable.
 */
const HELPER = process.env.KOBE_TEST_PI_RUNAS;
const WORKSPACE_GID = process.getgid?.() ?? -1;
const BRIEF = "the project brief\n";

function run(args: readonly string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(HELPER as string, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH },
    });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

async function tree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const abs = path.join(dir, e.name);
    const info = await lstat(abs);
    const text = e.isFile() ? await readFile(abs, "utf8") : "";
    out.push(`${path.relative(base, abs)} ${info.uid} ${(info.mode & 0o7777).toString(8)} ${text}`);
    if (e.isDirectory()) out.push(...(await tree(abs, base)));
  }
  return out;
}

describe.runIf(HELPER !== undefined)("project files are read-only to tools (KOBE-162)", () => {
  let identities: PiIdentities;
  let scratch: string;
  const held: PiIdentity[] = [];
  let umask: number;

  beforeAll(async () => {
    umask = process.umask(0o077);
    identities = await loadPiIdentities(HELPER as string, 1);
    scratch = await mkdtemp(path.join("/dev/shm", "kobe-projects-"));
    await chmod(scratch, 0o755);
  });
  afterAll(async () => {
    process.umask(umask);
    await chmod(scratch, 0o755);
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    for (const identity of held.splice(0)) {
      await identities.killAllPatiently(identity, [10, 10]);
      identities.release(identity);
    }
  });

  /** A workspace as the pod has it: group-writable root, the agent's mirror of the project files. */
  async function workspace(): Promise<string> {
    const root = path.join(scratch, `ws-${Math.random().toString(36).slice(2)}`);
    await mkdir(root);
    await chown(root, process.getuid?.() ?? 0, WORKSPACE_GID);
    await chmod(root, 0o2775);
    const body = Buffer.from(BRIEF);
    await writeFileAtomic(root, "projects/acme/docs/brief.md", Readable.from([body]), {
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
      mtimeMs: Date.now(),
      mode: 0o444,
    });
    await lockServerOwned(root, ["projects/"]);
    // The user's own folder next to it stays shared and writable (control).
    await mkdir(path.join(root, "mine"), { mode: 0o2775 });
    await chmod(path.join(root, "mine"), 0o2775);
    return root;
  }

  async function identity(): Promise<PiIdentity> {
    const id = await identities.acquire(1000);
    held.push(id);
    return id;
  }

  const attempts = (root: string): Record<string, string> => {
    const p = `${root}/projects`;
    const f = `${p}/acme/docs/brief.md`;
    return {
      overwrite: `echo x > ${f}`,
      append: `echo x >> ${f}`,
      truncate: `: > ${f}`,
      createInFolder: `echo x > ${p}/acme/docs/new.md`,
      createInSlug: `echo x > ${p}/acme/new.md`,
      createInProjects: `echo x > ${p}/other.md`,
      mkdirInProjects: `mkdir ${p}/other`,
      mkdirInFolder: `mkdir ${p}/acme/docs/d`,
      remove: `rm -f ${f}`,
      removeTree: `rm -rf ${p}/acme`,
      renameFile: `mv ${f} ${f}.x`,
      renameFolder: `mv ${p}/acme ${p}/acme2`,
      renameOver: `echo y > ${root}/mine/y && mv ${root}/mine/y ${f}`,
      chmodFile: `chmod 666 ${f}`,
      chmodDir: `chmod 777 ${p}/acme/docs`,
      chmodSlug: `chmod 777 ${p}`,
      symlink: `ln -s /etc/passwd ${p}/acme/link`,
      moveIn: `echo z > ${root}/mine/z && mv ${root}/mine/z ${p}/acme/z`,
    };
  };

  for (const [label, pick] of [
    ["executor off: Pi's own uid", (id: PiIdentity) => identities.command(id, "/bin/sh", [])],
    [
      "executor on: the partner uid",
      (id: PiIdentity) => identities.partnerCommand(id, "/bin/sh", []),
    ],
  ] as const) {
    it(`cannot write, create, delete, rename or chmod anything under projects/ (${label})`, async () => {
      const root = await workspace();
      const id = await identity();
      const before = await tree(path.join(root, "projects"));
      const script = Object.entries(attempts(root))
        .map(([name, cmd]) => `( ${cmd} ) >/dev/null 2>&1; echo ${name}=$?`)
        .join("\n");
      const command = pick(id) as string[];
      const out = await run([...command, "-c", script]);
      for (const name of Object.keys(attempts(root))) {
        expect(out.stdout, name).toMatch(new RegExp(`^${name}=[1-9]`, "m"));
      }
      expect(await tree(path.join(root, "projects"))).toEqual(before);
      expect(await readFile(path.join(root, "projects/acme/docs/brief.md"), "utf8")).toBe(BRIEF);
      // Control: the same uid does write the user's own shared folder, and reads the project file.
      const control = await run([
        ...(pick(id) as string[]),
        "-c",
        `echo ok > ${root}/mine/ok && cat ${root}/projects/acme/docs/brief.md`,
      ]);
      expect(control.code).toBe(0);
      expect(control.stdout).toContain("the project brief");
    });
  }

  it("a tool that swaps the whole projects/ folder is undone by the next sync (the root is group-writable)", async () => {
    const root = await workspace();
    const id = await identity();
    const swap = await run([
      ...(identities.command(id, "/bin/sh", []) as string[]),
      "-c",
      `mv ${root}/projects ${root}/stolen && mkdir -p ${root}/projects/acme/docs && echo fake > ${root}/projects/acme/docs/brief.md`,
    ]);
    expect(swap.code).toBe(0);
    // The agent's next write into the area moves the foreign folder aside and rebuilds its own.
    await ensureParents(root, "projects/acme/docs/brief.md");
    const body = Buffer.from(BRIEF);
    await writeFileAtomic(root, "projects/acme/docs/brief.md", Readable.from([body]), {
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
      mtimeMs: Date.now(),
      mode: 0o444,
    });
    await lockServerOwned(root, ["projects/"]);
    expect(await readFile(path.join(root, "projects/acme/docs/brief.md"), "utf8")).toBe(BRIEF);
    const info = await lstat(path.join(root, "projects"));
    expect(info.uid).toBe(process.getuid?.());
    expect(info.mode & 0o022).toBe(0);
    const names = await readdir(root);
    expect(names.some((n) => n.startsWith("projects.replaced-"))).toBe(true);
    expect(partnerOf(id).uid).toBeGreaterThan(id.uid); // both uids of the pair are covered above
  });

  it("a symlink swapped in for projects/ cannot make the agent chmod what it points at (KOBE-162 review)", async () => {
    const root = await workspace();
    const id = await identity();
    // The agent-owned directory a tool would aim at: Pi's runtime dir, owner-only.
    const victim = path.join(scratch, `victim-${Math.random().toString(36).slice(2)}`);
    await mkdir(path.join(victim, "agent"), { recursive: true });
    await writeFile(path.join(victim, "model.json"), "token", { mode: 0o600 });
    await chmod(victim, 0o700);
    await chmod(path.join(victim, "agent"), 0o700);
    const before = await tree(victim);
    const swap = await run([
      ...(identities.command(id, "/bin/sh", []) as string[]),
      "-c",
      `mv ${root}/projects ${root}/stolen && ln -s ${victim} ${root}/projects`,
    ]);
    expect(swap.code).toBe(0);
    // A sync pass: make the folders, write the file, lock the area.
    await ensureParents(root, "projects/acme/docs/brief.md");
    const body = Buffer.from(BRIEF);
    await writeFileAtomic(root, "projects/acme/docs/brief.md", Readable.from([body]), {
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
      mtimeMs: Date.now(),
      mode: 0o444,
    }).catch(() => undefined);
    await lockServerOwned(root, ["projects/"]);
    expect(await tree(victim)).toEqual(before);
    expect((await lstat(path.join(root, "projects"))).isDirectory()).toBe(true);
    const aside = (await readdir(root)).find((n) => n.startsWith("projects.replaced-")) ?? "";
    expect((await lstat(path.join(root, aside))).isSymbolicLink()).toBe(true);
  });
});
