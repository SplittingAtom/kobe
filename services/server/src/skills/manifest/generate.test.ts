import { describe, expect, it, vi } from "vitest";
import {
  ServerCallError,
  type ServerCallClient,
  type ServerCallInput,
} from "../../models/gateway-client.js";
import { createSkillManifestGenerator, type ModelTarget } from "./generate.js";
import { MANIFEST_PROMPT_SKILL_MD_MAX_CHARS } from "./prompt.js";

/**
 * KOBE-564 ac-3: the generator calls the member's chosen model once, as a run-less server call,
 * and hands back a manifest the package contract accepts (or a clear reason why not).
 */
const TEAM = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const USER = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const enc = new TextEncoder();
const skillMd = (name = "sales-report", body = "Add a totals row.") =>
  `---\nname: ${name}\ndescription: Builds the quarterly sales report. Use when asked for sales figures.\n---\n# ${name}\n${body}\n`;
const files = (over: Record<string, string> = {}, name?: string) =>
  new Map(
    Object.entries({
      "SKILL.md": skillMd(name),
      "scripts/report.py": "import pandas\nprint('hi')\n",
      ...over,
    }).map(([p, t]) => [p, enc.encode(t)]),
  );
const ENABLED: ModelTarget = { ok: true, alias: "k2", gatewayModel: "openai/k2", reasoning: false };
const log = { info: vi.fn(), warn: vi.fn() };

function harness(reply: string | Error, target: ModelTarget = ENABLED) {
  const calls: ServerCallInput[] = [];
  const client: ServerCallClient = {
    complete: async (input) => {
      calls.push(input);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const generator = createSkillManifestGenerator({
    db: {} as never,
    client,
    log,
    resolveModel: async () => target,
    knownTags: async () => ["sales", "finance"],
  });
  return { generator, calls };
}
const request = (over: Record<string, unknown> = {}) => ({
  teamId: TEAM,
  userId: USER,
  modelAlias: "k2",
  name: "sales-report",
  semver: "1.2.0",
  files: files(),
  license: "Proprietary",
  ...over,
});

describe("createSkillManifestGenerator", () => {
  it("asks the chosen model once, as skill_manifest with no run, with SKILL.md and the file list as data", async () => {
    const { generator, calls } = harness(
      JSON.stringify({
        summary: "Quarterly sales reports.",
        tags: ["sales", "nope tag"],
        capabilities: { packages: { pip: ["pandas"] } },
      }),
    );
    const out = await generator.generate(request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source).toBe("model");
    expect(out.model).toEqual({ alias: "k2", gatewayModel: "openai/k2" });
    expect(out.manifest).toEqual({
      apiVersion: "kobe.dev/skill/v1",
      name: "sales-report",
      version: "1.2.0",
      summary: "Quarterly sales reports.",
      tags: ["sales"],
      license: "Proprietary",
      capabilities: { packages: { pip: ["pandas"] } },
    });
    expect(new TextDecoder().decode(out.yaml)).toContain("summary: Quarterly sales reports.");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toMatchObject({
      purpose: "skill_manifest",
      teamId: TEAM,
      userId: USER,
      model: "openai/k2",
      reasoning: false,
    });
    expect(call?.threadId).toBeUndefined();
    expect(call?.runId).toBeUndefined();
    expect(call?.messages).toHaveLength(2);
    const user = call?.messages[1]?.content ?? "";
    expect(user).toContain("Skill name: sales-report");
    expect(user).toContain("Version: 1.2.0");
    expect(user).toContain("Known tags: sales, finance");
    expect(user).toContain("- scripts/report.py");
    expect(user).toContain("Add a totals row.");
    expect(user).toMatch(/<<<skill [0-9a-f]{32}>>>/);
    expect(user).not.toContain("- SKILL.md");
  });

  it("a reply with no JSON still gives a manifest, from SKILL.md's description (source seed)", async () => {
    const { generator } = harness("Sorry, I can't.");
    const out = await generator.generate(request());
    expect(out.ok && out.source).toBe("seed");
    expect(out.ok && out.manifest.summary).toBe(
      "Builds the quarterly sales report. Use when asked for sales figures.",
    );
    expect(log.info).toHaveBeenCalled();
  });

  it("refuses before calling when SKILL.md is invalid or names another skill", async () => {
    const { generator, calls } = harness("{}");
    const bad = await generator.generate(
      request({ files: new Map([["SKILL.md", enc.encode("no frontmatter")]]) }),
    );
    expect(bad).toMatchObject({ ok: false, code: "invalid_skill_md" });
    const other = await generator.generate(request({ files: files({}, "other-skill") }));
    expect(other).toMatchObject({ ok: false, code: "name_mismatch" });
    expect(calls).toEqual([]);
  });

  it("never falls back to another model: a disabled alias or no default refuses", async () => {
    const disabled = harness("{}", { ok: false, code: "model_not_enabled" });
    expect(await disabled.generator.generate(request())).toMatchObject({
      ok: false,
      code: "model_not_enabled",
      message: "The model k2 is not enabled in this team.",
    });
    const none = harness("{}", { ok: false, code: "no_model" });
    expect(await none.generator.generate(request({ modelAlias: undefined }))).toMatchObject({
      ok: false,
      code: "no_model",
    });
    expect(disabled.calls).toEqual([]);
  });

  it("a failed call is a failure with the gateway's code, never a crash", async () => {
    const { generator } = harness(new ServerCallError("budget_exhausted", 402));
    const out = await generator.generate(request());
    expect(out).toMatchObject({
      ok: false,
      code: "call_failed",
      detail: "budget_exhausted",
      message: "The model k2 did not answer (budget exhausted).",
    });
    expect(log.warn).toHaveBeenCalled();
  });

  it("writes one manifest at a time per member (review M1): a second request while one runs is busy", async () => {
    const waiting: ((reply: string) => void)[] = [];
    const release = () => waiting.splice(0).forEach((r) => r('{"summary": "Slow."}'));
    const client: ServerCallClient = {
      complete: () => new Promise<string>((r) => waiting.push(r)),
    };
    const generator = createSkillManifestGenerator({
      db: {} as never,
      client,
      log,
      resolveModel: async () => ENABLED,
      knownTags: async () => [],
    });
    const first = generator.generate(request());
    await new Promise((r) => setTimeout(r, 0));
    expect(await generator.generate(request())).toMatchObject({ ok: false, code: "busy" });
    // Another member is not held up by it.
    const other = generator.generate(request({ userId: TEAM }));
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await first).ok).toBe(true);
    expect((await other).ok).toBe(true);
    const after = generator.generate(request());
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await after).ok).toBe(true);
  });

  it("cuts a long SKILL.md in the prompt instead of refusing it", async () => {
    const long = skillMd("sales-report", "x".repeat(MANIFEST_PROMPT_SKILL_MD_MAX_CHARS + 5_000));
    const { generator, calls } = harness('{"summary": "Long."}');
    const out = await generator.generate(request({ files: files({ "SKILL.md": long }) }));
    expect(out.ok).toBe(true);
    const user = calls[0]?.messages[1]?.content ?? "";
    expect(user).toContain("SKILL.md cut at");
    expect(user.length).toBeLessThan(MANIFEST_PROMPT_SKILL_MD_MAX_CHARS + 2_000);
  });
});
