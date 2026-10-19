import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  KobeToolsRequest,
  KobeToolsResponse,
  SkillDraftSaveResultFrame,
} from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PushPathError, type PushedFile } from "../workspace/sync.js";
import { SkillDraftBroker } from "./skill-draft-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
const DRAFT = "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b";
const SHA = "a".repeat(64);

type SaveRequest = Extract<KobeToolsRequest, { op: "skill.draft_save" }>;
const request = (folder: string, id = "kt_1"): SaveRequest => ({
  id,
  op: "skill.draft_save",
  tool_call_id: `call_${id}`,
  tool: "save_skill_draft",
  input: { folder },
});
const saved = (request_id: string): SkillDraftSaveResultFrame => ({
  v: 1,
  type: "skill.draft_save_result",
  request_id,
  ok: true,
  op: "skill_draft_save",
  draft_id: DRAFT,
  name: "close-helper",
  created: true,
  rev: 1,
  file_count: 2,
});

let base: string;
let root: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "kobe-skilldraft-")));
  root = path.join(base, "workspace");
  const skill = path.join(root, "skills", "close-helper");
  await mkdir(path.join(skill, "references"), { recursive: true });
  await mkdir(path.join(skill, "scripts", "__pycache__"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: close-helper\n---\n");
  await writeFile(path.join(skill, "references", "steps.md"), "Steps.");
  await writeFile(path.join(skill, "scripts", "__pycache__", "x.pyc"), "cache");
  await writeFile(path.join(skill, ".DS_Store"), "junk");
  await writeFile(path.join(base, "secret"), "x");
  await symlink(path.join(base, "secret"), path.join(skill, "link.md"));
  await mkdir(path.join(base, "elsewhere"), { recursive: true });
  await writeFile(path.join(base, "elsewhere", "SKILL.md"), "outside");
  await symlink(path.join(base, "elsewhere"), path.join(root, "skills", "linked"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

function setup(options: { sends?: boolean; push?: (rel: string) => Promise<PushedFile> } = {}) {
  const frames: Record<string, unknown>[] = [];
  const order: string[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new SkillDraftBroker({
    root,
    send: (frame) => {
      order.push("send");
      frames.push(frame as unknown as Record<string, unknown>);
      return options.sends ?? true;
    },
    pushPath:
      options.push ??
      (async (rel) => {
        order.push(`push ${rel}`);
        return { path: rel, rev: 4, sha256: SHA, size: 6 };
      }),
  });
  return {
    broker,
    frames,
    order,
    replies,
    reply: (r: KobeToolsResponse) => replies.push(r),
    settle: () => new Promise((r) => setTimeout(r, 30)),
  };
}

const codeOf = (r: KobeToolsResponse | undefined) =>
  r && !r.ok ? (r as { error: { code: string } }).error.code : undefined;

describe("SkillDraftBroker (KOBE-442)", () => {
  it("pushes every file of the folder, then names the pushed entries, and relays the answer", async () => {
    const u = setup();
    u.broker.save(THREAD, RUN, request("close-helper"), u.reply);
    await u.settle();
    // No symlink, cache directory or hidden file is pushed; pushes come before the frame.
    expect(u.order).toEqual([
      "push skills/close-helper/SKILL.md",
      "push skills/close-helper/references/steps.md",
      "send",
    ]);
    expect(u.frames).toEqual([
      {
        v: 1,
        type: "skill.draft_save",
        request_id: "sd_1",
        run_id: RUN,
        thread_id: THREAD,
        tool_call_id: "call_kt_1",
        tool: "save_skill_draft",
        input: { folder: "close-helper" },
        files: [
          { path: "skills/close-helper/SKILL.md", rev: 4, sha256: SHA, size: 6 },
          { path: "skills/close-helper/references/steps.md", rev: 4, sha256: SHA, size: 6 },
        ],
      },
    ]);
    expect(u.broker.onResult(saved("sd_1"))).toBe(true);
    expect(u.replies).toEqual([
      {
        id: "kt_1",
        ok: true,
        op: "skill_draft_save",
        draft_id: DRAFT,
        name: "close-helper",
        created: true,
        rev: 1,
        file_count: 2,
      },
    ]);
    expect(u.broker.pendingCount).toBe(0);
    expect(u.broker.onResult(saved("sd_1"))).toBe(false);
  });

  it("sends nothing for a missing folder, a linked folder or an empty one", async () => {
    await mkdir(path.join(root, "skills", "empty"), { recursive: true });
    for (const [folder, code] of [
      ["missing", "not_found"],
      ["linked", "invalid_path"],
      ["empty", "not_found"],
    ] as const) {
      const u = setup();
      u.broker.save(THREAD, RUN, request(folder), u.reply);
      await u.settle();
      expect(u.frames, folder).toEqual([]);
      expect(codeOf(u.replies[0]), folder).toBe(code);
    }
  });

  it("refuses a folder over the draft caps before pushing anything", async () => {
    const big = path.join(root, "skills", "big");
    await mkdir(big, { recursive: true });
    await writeFile(path.join(big, "SKILL.md"), "x");
    await writeFile(path.join(big, "data.bin"), Buffer.alloc(5 * 1024 * 1024));
    const u = setup();
    u.broker.save(THREAD, RUN, request("big"), u.reply);
    await u.settle();
    expect(u.order).toEqual([]);
    expect(codeOf(u.replies[0])).toBe("too_large");
  });

  it("answers once on a failed push, no run, a closed wire, or a run that ends meanwhile", async () => {
    const failing = setup({ push: () => Promise.reject(new PushPathError("nope")) });
    failing.broker.save(THREAD, RUN, request("close-helper"), failing.reply);
    await failing.settle();
    expect([failing.frames, codeOf(failing.replies[0])]).toEqual([[], "not_synced"]);

    const noRun = setup();
    noRun.broker.save(THREAD, undefined, request("close-helper"), noRun.reply);
    expect(codeOf(noRun.replies[0])).toBe("not_allowed");

    const closed = setup({ sends: false });
    closed.broker.save(THREAD, RUN, request("close-helper"), closed.reply);
    await closed.settle();
    expect(codeOf(closed.replies[0])).toBe("unavailable");

    const ended = setup();
    ended.broker.save(THREAD, RUN, request("close-helper"), ended.reply);
    ended.broker.failRun(RUN, "run ended");
    await ended.settle();
    expect(ended.frames).toEqual([]);
    expect(ended.replies.map(codeOf)).toEqual(["unavailable"]);
  });

  it("relays a server refusal as the tool's error", async () => {
    const u = setup();
    u.broker.save(THREAD, RUN, request("close-helper"), u.reply);
    await u.settle();
    u.broker.onResult({
      v: 1,
      type: "skill.draft_save_result",
      request_id: "sd_1",
      ok: false,
      error: { code: "invalid_skill", message: "SKILL.md has no description." },
    });
    expect(u.replies).toEqual([
      {
        id: "kt_1",
        ok: false,
        error: { code: "invalid_skill", message: "SKILL.md has no description." },
      },
    ]);
  });
});
