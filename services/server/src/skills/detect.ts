import path from "node:path";
import type { SkillBundleRef } from "@kobe/protocol";
import type { RunSkillRef, RunSkillUse } from "@kobe/db";
import type { SkillRef } from "../resolver/resolve.js";
import { SKILLS_DIR, SKILLS_STORE_SUBDIR } from "../sandbox/constants.js";

/**
 * Skill use, seen by the server (KOBE-297). Pi uses a skill by `read`-ing its SKILL.md from the
 * directory it was given with `--skill`: `<SKILLS_DIR>/store/sk-<sha256>/` for a bundle
 * (sandbox-agent skills/store.ts; Kobe's own skills too since KOBE-317). A call counts
 * only when its normalized absolute path is exactly the SKILL.md of a skill in the run's own list
 * (`runs.skill_refs`, written with `run.start`), and only once its result came back without error.
 * The name is the server's, from that list: nothing the sandbox labels a call with is read, a
 * forged hash is not in the list, and a SKILL.md anywhere else (the workspace) is just a file.
 */

const SKILL_MD = "SKILL.md";
/** Longer paths are not skill paths (the longest is the store root plus 64 hex and SKILL.md). */
const MAX_PATH = 512;
const STORE = path.posix.join(SKILLS_DIR, SKILLS_STORE_SUBDIR);

/** The SKILL.md path of a skill the run was given. */
function skillMdPath(ref: RunSkillRef): string | undefined {
  // `builtin` refs belong to runs from before KOBE-317, whose tool calls were matched long ago.
  return ref.sha256 === undefined
    ? undefined
    : path.posix.join(STORE, `sk-${ref.sha256}`, SKILL_MD);
}

/** The run's skill whose SKILL.md this tool call reads, if any. */
export function matchSkillRead(
  tool: string,
  input: unknown,
  refs: readonly RunSkillRef[],
): RunSkillRef | undefined {
  if (tool !== "read" || refs.length === 0) return undefined;
  const raw = (input as { path?: unknown } | null | undefined)?.path;
  if (typeof raw !== "string" || raw.length > MAX_PATH || raw.includes("\u0000")) return undefined;
  if (!path.posix.isAbsolute(raw)) return undefined;
  const normalized = path.posix.normalize(raw);
  return refs.find((ref) => skillMdPath(ref) === normalized);
}

/**
 * What `run.start` lists, as recorded with the run: each bundle with the source of the effective
 * skill it was listed for (same name and hash). Two skills with identical
 * bytes share one `sk-<hash>/` directory, so a read of it can only be told as one of them: the
 * first listed (in resolution order, KOBE-315) keeps the path, the others are not recorded.
 * A bundle with no matching effective skill is left out rather than guessed.
 */
export function runSkillRefs(
  bundles: readonly SkillBundleRef[],
  effective: readonly SkillRef[],
): RunSkillRef[] {
  const refs: RunSkillRef[] = [];
  const paths = new Set<string>();
  for (const b of bundles) {
    const skill = effective.find((s) => s.name === b.name && s.hash === b.sha256);
    if (skill?.source === undefined || paths.has(b.sha256)) continue;
    paths.add(b.sha256);
    refs.push({
      name: b.name,
      source: skill.source,
      sha256: b.sha256,
      ...(skill.semver ? { semver: skill.semver } : {}),
    });
  }
  return refs;
}

interface EventLike {
  readonly type: string;
  readonly payload: unknown;
}

interface ToolPayload {
  readonly tool_call_id?: unknown;
  readonly tool?: unknown;
  readonly input?: unknown;
  readonly is_error?: unknown;
}

/**
 * Skill uses in one batch of run events: a successful `tool.result` of `read` whose `tool.call`
 * (same batch) read a skill's SKILL.md. `unresolved` names results whose call came in an earlier
 * batch: the caller reads that call's input from `run_events` and matches it with
 * {@link matchSkillRead}.
 */
export function skillUsesFrom(
  events: readonly EventLike[],
  refs: readonly RunSkillRef[],
): { uses: RunSkillUse[]; unresolved: string[] } {
  if (refs.length === 0) return { uses: [], unresolved: [] };
  const inputs = new Map<string, unknown>();
  const uses: RunSkillUse[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const p = event.payload as ToolPayload;
    if (typeof p?.tool_call_id !== "string" || p.tool !== "read") continue;
    if (event.type === "tool.call") inputs.set(p.tool_call_id, p.input);
    if (event.type !== "tool.result" || p.is_error !== false || seen.has(p.tool_call_id)) continue;
    seen.add(p.tool_call_id);
    if (!inputs.has(p.tool_call_id)) {
      unresolved.push(p.tool_call_id);
      continue;
    }
    const ref = matchSkillRead("read", inputs.get(p.tool_call_id), refs);
    if (ref) uses.push({ tool_call_id: p.tool_call_id, name: ref.name, source: ref.source });
  }
  return { uses, unresolved };
}
