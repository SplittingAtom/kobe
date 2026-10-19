import { sql, type KobeTx } from "@kobe/db";
import type { SkillBundleRef } from "@kobe/protocol";
import { isBlocked } from "../skills/blocklist.js";
import type { RunAgentResolver } from "./seams.js";

/**
 * Skill eval executions (KOBE-325, SK16, SK25): a thread marked `skill_eval` runs the Kobe agent
 * as usual (its version, model, the team's policy, egress and budget) except that (1) its skills
 * are the eval's alone: with the skill, only the eval's stored runtime bundle (scanned at the
 * eval's start); without it, none at all (no Required, agent-named, offered or personal skill);
 * (2) the owner's personal connector credentials are never read, so only connectors needing no
 * personal key connect (coordinator decision: an eval never runs on a member's, or a Registry
 * reviewer's, own keys). An execution that is not running, or a bundle blocklisted since, fails
 * the run; it never falls back to the usual skills.
 */
export function withSkillEvals(base: RunAgentResolver): RunAgentResolver {
  return {
    ...base,
    async resolve(tx, input) {
      if (!input.skillEval) return base.resolve(tx, input);
      const exec = await evalExecutionOf(tx, input.teamId, input.threadId, input.ownerUserId);
      if (!exec || input.agentId === null)
        return { ok: false, error: { code: "skill_eval_unavailable", message: "" } };
      const strict = { ...input, noPersonalGrants: true as const };
      if (!exec.withSkill) return base.resolve(tx, { ...strict, noSkills: true });
      if (await isBlocked(tx, exec.runtimeHash))
        return { ok: false, error: { code: "skill_blocklisted", message: "" } };
      const bundle: SkillBundleRef = {
        name: exec.skillName,
        sha256: exec.runtimeHash,
        size: exec.bundleSize,
      };
      return base.resolve(tx, {
        ...strict,
        onlySkill: {
          ref: { name: exec.skillName, hash: exec.runtimeHash, source: exec.source },
          bundle,
        },
      });
    },
  };
}

interface EvalExecution {
  readonly withSkill: boolean;
  readonly source: "draft" | "team" | "personal";
  readonly skillName: string;
  readonly runtimeHash: string;
  readonly bundleSize: number;
}

/** The running execution an eval thread belongs to, of that owner, or null. */
async function evalExecutionOf(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  ownerUserId: string,
): Promise<EvalExecution | null> {
  const res = await tx.execute<{
    with_skill: boolean;
    skill_name: string;
    runtime_hash: string;
    bundle_size: number;
    subject_kind: "draft" | "team" | "personal";
  }>(sql`
    SELECT x.with_skill, r.skill_name, r.runtime_hash, r.bundle_size, r.subject_kind
      FROM skill_eval_results x
      JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
     WHERE x.team_id = ${teamId} AND x.thread_id = ${threadId}
       AND x.state IN ('starting', 'running') AND r.started_by = ${ownerUserId}
       AND r.status IN ('queued', 'running')`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    withSkill: row.with_skill,
    source: row.subject_kind,
    skillName: row.skill_name,
    runtimeHash: row.runtime_hash,
    bundleSize: Number(row.bundle_size),
  };
}
