import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxToServerFrame, SkillBundleRef } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillFetcher } from "./skills/client.js";
import { SkillStore } from "./skills/store.js";
import { RUN, RUN_2, TOKEN, runStart, startHarness, type Harness } from "./testing/harness.js";
import { goodBundle, sha256 } from "./testing/zip.js";

/**
 * KOBE-82 through the real agent, wire frames and HTTP client (fake Pi): the run's effective
 * skills are fetched from the server's sandbox listener with the wire token, verified, extracted,
 * registered with Pi (`--skill`), and removed again when a later run no longer lists them.
 */
let h: Harness | undefined;
let http: Server;
let skillsRoot: string;
const offered = new Map<string, Buffer>();
const requests: { url: string | undefined; authorization: string | undefined }[] = [];

beforeEach(async () => {
  offered.clear();
  requests.length = 0;
  http = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const hash = req.url?.split("/").pop() ?? "";
    const bytes = req.headers.authorization === `Bearer ${TOKEN}` ? offered.get(hash) : undefined;
    if (!bytes) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "content-length": bytes.length }).end(bytes);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  skillsRoot = path.join(await mkdtemp(path.join(tmpdir(), "kobe-skills-e2e-")), "skills");
});
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
  await new Promise((resolve) => http.close(resolve));
  await rm(path.dirname(skillsRoot), { recursive: true, force: true });
});

const store = () =>
  new SkillStore({
    root: skillsRoot,
    identities: false,
    fetch: createSkillFetcher({
      serverUrl: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`,
      readToken: () => Promise.resolve(TOKEN),
    }),
  });

function offer(name: string, note: string): SkillBundleRef {
  const zip = goodBundle([{ name: "note.md", data: note }]);
  offered.set(sha256(zip), zip);
  return { name, sha256: sha256(zip), size: zip.length };
}
const withSkills = (refs: readonly SkillBundleRef[], extra: Record<string, unknown> = {}) =>
  runStart("say:hi", {
    config: { skills: refs.map((r) => r.name), skill_bundles: refs, ...extra },
  });
const launches = async () => (await h?.commandsLog())?.filter((c) => "argv" in c) ?? [];
const skillArgs = (argv: string[]) =>
  argv.flatMap((a, i) => (a === "--skill" ? [argv[i + 1]] : []));
const settled = (runId: string) => (f: SandboxToServerFrame) =>
  f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled";

describe("skills at run start", () => {
  it("fetches with the wire token, materializes and registers exactly the listed skills with Pi", async () => {
    const a = offer("alpha", "a");
    const b = offer("beta", "b");
    h = await startHarness({ skills: store() });
    expect(await h.server.command(withSkills([a, b]))).toMatchObject({ ok: true });
    await h.server.waitFor(settled(RUN));

    expect(requests.map((r) => r.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(requests.map((r) => r.url).sort()).toEqual(
      [`/v1/sandbox/skills/${a.sha256}`, `/v1/sandbox/skills/${b.sha256}`].sort(),
    );
    const [launch] = await launches();
    const dirs = skillArgs(launch?.argv as string[]);
    expect(dirs).toEqual([
      path.join(skillsRoot, "store", `sk-${a.sha256}`),
      path.join(skillsRoot, "store", `sk-${b.sha256}`),
    ]);
    for (const dir of dirs) expect(existsSync(path.join(dir ?? "", "SKILL.md"))).toBe(true);
    expect(readFileSync(path.join(dirs[0] ?? "", "note.md"), "utf8")).toBe("a");
    // Discovery stays off: only the explicit paths load.
    expect(launch?.argv).toContain("--no-skills");
  });

  it("removes a skill the next run no longer lists, and restarts Pi without it (no stale skills)", async () => {
    const a = offer("alpha", "a");
    const b = offer("beta", "b");
    h = await startHarness({ skills: store() });
    await h.server.command(withSkills([a, b]));
    await h.server.waitFor(settled(RUN));
    const second = { ...withSkills([b]), run_id: RUN_2 };
    expect(await h.server.command(second)).toMatchObject({ ok: true });
    await h.server.waitFor(settled(RUN_2));

    expect(await readdir(path.join(skillsRoot, "store"))).toEqual([`sk-${b.sha256}`]);
    const all = await launches();
    expect(all).toHaveLength(2);
    expect(skillArgs(all[1]?.argv as string[])).toEqual([
      path.join(skillsRoot, "store", `sk-${b.sha256}`),
    ]);

    // And with no skills at all, none stay.
    const third = {
      ...runStart("say:hi", { config: { approval_mode: "auto" } }),
      run_id: "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f607183",
    };
    expect(await h.server.command(third)).toMatchObject({ ok: true });
    await h.server.waitFor(settled("4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f607183"));
    expect(await readdir(path.join(skillsRoot, "store"))).toEqual([]);
  });

  it("fails the run, starting no Pi, when the bytes do not match the listed SHA-256", async () => {
    const a = offer("alpha", "a");
    offered.set(a.sha256, goodBundle([{ name: "note.md", data: "X" }])); // same length, other bytes
    h = await startHarness({ skills: store() });
    const result = await h.server.command(withSkills([a]));
    expect(result).toMatchObject({ ok: false, error: { code: "pi_unavailable" } });
    expect(JSON.stringify(result)).toMatch(/SHA-256/);
    expect(await launches().catch(() => [])).toHaveLength(0);
    expect(await readdir(path.join(skillsRoot, "store"))).toEqual([]);
  });

  it("fails the run when the server does not offer the bundle any more", async () => {
    const a = offer("alpha", "a");
    offered.clear();
    h = await startHarness({ skills: store() });
    expect(await h.server.command(withSkills([a]))).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable" },
    });
  });

  it("fails a run that lists skills when this sandbox has no skills store", async () => {
    const a = offer("alpha", "a");
    h = await startHarness();
    expect(await h.server.command(withSkills([a]))).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable" },
    });
  });

  it("rejects skill names without a bundle", async () => {
    h = await startHarness({ skills: store() });
    expect(
      await h.server.command(runStart("say:hi", { config: { skills: ["ghost"] } })),
    ).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
  });

  it("starts as before without skills, and without a store", async () => {
    h = await startHarness();
    expect(await h.server.command(runStart("say:hi"))).toMatchObject({ ok: true });
    await h.server.waitFor(settled(RUN));
    const [launch] = await launches();
    expect(skillArgs(launch?.argv as string[])).toEqual([]);
  });

  it("advertises skill support in hello only when it has a skills store (older agents send none)", async () => {
    h = await startHarness({ skills: store() });
    expect(h.server.frames("hello").at(-1)?.capabilities).toEqual(["skill_bundles"]);
    await h.close();
    h = await startHarness();
    expect(h.server.frames("hello").at(-1)).not.toHaveProperty("capabilities");
  });

  it("ignores config fields it does not know instead of failing the run", async () => {
    h = await startHarness();
    const frame = runStart("say:hi", { config: { approval_mode: "auto", future_field: [1] } });
    expect(await h.server.command(frame)).toMatchObject({ ok: true });
  });
});
