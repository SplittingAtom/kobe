import { PROVENANCE_API_VERSION, provenanceSchema, type SkillProvenance } from "@kobe/protocol";
import { externalScannerOn, queuedScan } from "./external-scan-result.js";
import {
  and,
  eq,
  skillPromotionRequests,
  sql,
  teamSkillSettings,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { teamRoleAllows } from "../../authz/permissions.js";
import type { BlobStore } from "../../retention/blobs.js";
import { ensureObject, scanDocument } from "../kobe-seed.js";
import type { SkillStore } from "../skill-store.js";
import { submissionRight } from "./maintainers.js";
import {
  lockedTeamReview,
  preparePromotion,
  teamReviewRefusal,
  type PromoteSource,
  type PromotionPlan,
  type Refusal,
} from "./promote-check.js";

/**
 * Promotion (KOBE-333, SK19): the only act that moves skill content out of a team. A personal
 * version is promoted by its author; a team version by a Team admin, or by a Builder when the
 * team lets Builders promote without confirmation; otherwise a Builder's Promote waits in the
 * team's queue for a Team admin's one-click confirm or decline. Promoting checks SK20's rules
 * (`promote-check.ts`) and refuses with reasons, then submits: the package's bytes are copied to
 * the Site catalog's content-addressed store, and one transaction (in the source team's RLS
 * context) creates the catalog skill when the name is new, the `submitted` Registry version with
 * its Kobe-written provenance (scorecard numbers only), the review event, and the audit rows on
 * both sides (`skill.promoted` in the team, `registry.submitted` on the Site).
 */

export interface PromoteDeps {
  readonly db: KobeDb;
  readonly store: SkillStore;
  readonly blobs: BlobStore;
}

export interface Promoter {
  readonly userId: string;
  readonly role: TeamRole;
}

export type PromoteResult =
  | { readonly ok: true; readonly kind: "submitted"; readonly registryVersionId: string }
  | { readonly ok: true; readonly kind: "requested"; readonly requestId: string }
  | { readonly ok: false; readonly code: "refused"; readonly refusals: readonly Refusal[] }
  | {
      readonly ok: false;
      readonly code: "not_found" | "forbidden" | "legacy" | "already_requested" | "request_closed";
      readonly message: string;
    };

const forbidden = (message: string) => ({ ok: false, code: "forbidden", message }) as const;

/** The Builders-may-promote setting (SK19, default off). */
async function buildersMayPromote(tx: KobeTx, teamId: string): Promise<boolean> {
  const [row] = await tx
    .select({ on: teamSkillSettings.buildersMayPromote })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  return row?.on === true;
}

function provenanceOf(
  plan: PromotionPlan,
  source: PromoteSource,
  submitter: { userId: string; at: Date },
  confirmedBy: { userId: string; at: Date } | undefined,
): SkillProvenance {
  return provenanceSchema.parse({
    apiVersion: PROVENANCE_API_VERSION,
    name: plan.name,
    version: plan.semver,
    hashes: { runtime: plan.runtimeHash, package: plan.bundle.packageHash },
    source: {
      scope: source.scope,
      teamId: source.teamId,
      skillId: source.skillId,
      seq: plan.seq,
      semver: plan.semver,
    },
    submitter: { userId: submitter.userId, at: submitter.at.toISOString() },
    ...(confirmedBy
      ? { confirmedBy: { userId: confirmedBy.userId, at: confirmedBy.at.toISOString() } }
      : {}),
    fromConversation: plan.fromConversation,
    scan: {
      scanner: {
        name: "kobe-skill-scanner",
        version: plan.scan.ruleSetVersion,
        rulesVersion: plan.scan.ruleSetVersion,
      },
      verdict: plan.scan.verdict,
      findings: plan.scan.findings.map(({ category, rule, file, line }) => ({
        category,
        rule,
        file,
        line,
      })),
    },
    ...(plan.scorecard ? { scorecard: plan.scorecard } : {}),
    createdAt: submitter.at.toISOString(),
  });
}

/** A request decided already (declined, confirmed): a later decision answers 409. */
export class RequestClosedError extends Error {
  constructor() {
    super("the promotion request was already decided");
  }
}

/** A rule the plan passed no longer holds inside the submission's transaction. */
export class SubmitRefusedError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

/** The request's row lock; throws {@link RequestClosedError} unless it is still pending. */
async function lockOpenRequest(tx: KobeTx, teamId: string, id: string): Promise<void> {
  const res = await tx.execute<{ state: string }>(sql`
    SELECT state FROM skill_promotion_requests WHERE team_id = ${teamId} AND id = ${id} FOR UPDATE`);
  if (res.rows[0]?.state !== "pending") throw new RequestClosedError();
}

/** The catalog skill for the plan's name: the existing one, or a new one (maintainer-published). */
async function catalogSkill(
  tx: KobeTx,
  plan: PromotionPlan,
): Promise<{ id: string; created: boolean }> {
  if (plan.catalogSkillId) return { id: plan.catalogSkillId, created: false };
  const summary = (plan.bundle.manifest?.summary ?? plan.bundle.description).slice(0, 280);
  const res = await tx.execute<{ id: string }>(sql`
    INSERT INTO registry_skills (name, summary, publisher)
    VALUES (${plan.name}, ${summary}, 'maintainer') RETURNING id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("registry skill insert returned no row");
  return { id, created: true };
}

/** Submits a checked plan (no refusals). `confirmed`: a Team admin's confirmation of a request. */
async function submit(
  deps: PromoteDeps,
  plan: PromotionPlan,
  source: PromoteSource,
  submitterId: string,
  confirmed?: { readonly requestId: string; readonly by: string },
): Promise<string> {
  const { bundle } = plan;
  const runtimeKey = await ensureObject(deps.blobs, bundle.zip, plan.runtimeHash);
  const packageKey = bundle.packageZip
    ? await ensureObject(deps.blobs, bundle.packageZip, bundle.packageHash)
    : null;
  const now = new Date();
  const provenance = provenanceOf(
    plan,
    source,
    { userId: submitterId, at: now },
    confirmed ? { userId: confirmed.by, at: now } : undefined,
  );
  try {
    return await submitInTeam(deps, plan, source, submitterId, provenance, now, confirmed, {
      runtimeKey,
      packageKey,
    });
  } catch (err) {
    const refusal = uniqueRefusal(err);
    if (refusal) throw new SubmitRefusedError(refusal);
    throw err;
  }
}

/** A submission that lost a race on the catalog's unique keys, as a refusal (review C3-L3). */
function uniqueRefusal(err: unknown): Refusal | null {
  const e = err as {
    code?: unknown;
    constraint?: unknown;
    cause?: { code?: unknown; constraint?: unknown };
  };
  if ((e.cause?.code ?? e.code) !== "23505") return null;
  const constraint = String(e.cause?.constraint ?? e.constraint ?? "");
  if (constraint === "registry_versions_semver_unique")
    return { code: "already_submitted", message: "This version was just submitted." };
  return {
    code: "taken",
    message: "Someone else submitted under this name at the same time: preview again.",
  };
}

async function submitInTeam(
  deps: PromoteDeps,
  plan: PromotionPlan,
  source: PromoteSource,
  submitterId: string,
  provenance: SkillProvenance,
  now: Date,
  confirmed: { readonly requestId: string; readonly by: string } | undefined,
  keys: { readonly runtimeKey: string; readonly packageKey: string | null },
): Promise<string> {
  const { bundle } = plan;
  const { runtimeKey, packageKey } = keys;
  return withTeam(deps.db, source.teamId, async (tx) => {
    // The first decision on a request wins (review C4-M1): lock it and check it is still open,
    // before anything is written.
    if (confirmed) await lockOpenRequest(tx, source.teamId, confirmed.requestId);
    // The team's review again, its row held until commit (re-review LOW-R2).
    if (source.scope === "team") {
      const refusal = teamReviewRefusal(await lockedTeamReview(tx, source));
      if (refusal) throw new SubmitRefusedError(refusal);
    }
    // The submission right again, on the locked catalog skill (review C3-L3): a maintainer removed,
    // or a name taken, since the preview no longer goes through, and `seq` can't race.
    if (plan.catalogSkillId)
      await tx.execute(
        sql`SELECT 1 FROM registry_skills WHERE id = ${plan.catalogSkillId} FOR UPDATE`,
      );
    const right = await submissionRight(tx, plan.name, submitterId);
    if (!right.ok) throw new SubmitRefusedError({ code: right.code, message: right.message });
    if ((right.skill?.id ?? null) !== plan.catalogSkillId)
      throw new SubmitRefusedError({
        code: "taken",
        message: "The name's catalog entry changed while you promoted: preview again.",
      });
    const skill = await catalogSkill(tx, plan);
    const seq = await tx.execute<{ next: number }>(sql`
      SELECT COALESCE(max(seq), 0) + 1 AS next FROM registry_versions WHERE skill_id = ${skill.id}`);
    const sourceDoc = {
      scope: source.scope,
      teamId: source.teamId,
      skillId: source.skillId,
      seq: plan.seq,
      semver: plan.semver,
    };
    // The optional external scan is due from this moment (KOBE-341 review M1): recorded `queued`
    // with the submission, so Approve waits for it and a lost start shows.
    const scanDoc = {
      ...scanDocument(plan.scan),
      ...((await externalScannerOn(tx)) ? { external: queuedScan(now) } : {}),
    };
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO registry_versions (skill_id, publisher, semver, seq, runtime_hash, package_hash,
        runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
        scan, verdict, scorecard, state, submitted_by)
      VALUES (${skill.id}, 'maintainer', ${plan.semver}, ${Number(seq.rows[0]?.next ?? 1)},
        ${plan.runtimeHash}, ${bundle.packageHash}, ${runtimeKey}, ${bundle.zip.length},
        ${packageKey}, ${JSON.stringify(bundle.manifest ?? {})}::jsonb,
        ${JSON.stringify(provenance)}::jsonb, ${JSON.stringify(sourceDoc)}::jsonb,
        ${JSON.stringify(scanDoc)}::jsonb, ${plan.scan.verdict}::scan_verdict,
        ${plan.scorecard ? JSON.stringify(plan.scorecard) : null}::jsonb, 'submitted',
        ${submitterId})
      RETURNING id`);
    const versionId = inserted.rows[0]?.id;
    if (!versionId) throw new Error("registry version insert returned no row");
    await tx.execute(sql`
      INSERT INTO registry_review_events (version_id, actor_id, action)
      VALUES (${versionId}, ${submitterId}, 'submitted')`);
    if (confirmed) {
      await tx
        .update(skillPromotionRequests)
        .set({
          state: "confirmed",
          decidedBy: confirmed.by,
          decidedAt: now,
          registryVersionId: versionId,
        })
        .where(
          and(
            eq(skillPromotionRequests.teamId, source.teamId),
            eq(skillPromotionRequests.id, confirmed.requestId),
            eq(skillPromotionRequests.state, "pending"),
          ),
        );
      await recordAudit(tx, {
        action: "skill.promotion.confirmed",
        teamId: source.teamId,
        target: { requestId: confirmed.requestId, registryVersionId: versionId },
      });
    }
    await recordAudit(tx, {
      action: "skill.promoted",
      teamId: source.teamId,
      target: {
        skillId: source.skillId,
        scope: source.scope,
        version: plan.seq,
        semver: plan.semver,
        registryVersionId: versionId,
        files: plan.files.length,
        fixtures: plan.fixtures.length,
        fromConversation: plan.fromConversation,
        ...(confirmed ? { requestId: confirmed.requestId } : {}),
      },
    });
    await recordAudit(tx, {
      action: "registry.submitted",
      target: {
        registryVersionId: versionId,
        skillId: skill.id,
        name: plan.name,
        semver: plan.semver,
        newSkill: skill.created,
      },
    });
    return versionId;
  });
}

/** A team version's owner check is the store's; a personal one is the caller's own (the store). */
export async function promote(
  deps: PromoteDeps,
  source: PromoteSource,
  who: Promoter,
): Promise<PromoteResult> {
  if (source.scope === "team" && !teamRoleAllows(who.role, "team.skills.publish"))
    return forbidden("Only Builders and Team admins promote team skills.");
  const prepared = await preparePromotion(deps.db, deps.store, source, who.userId);
  if (!prepared.ok) return prepared;
  const { plan } = prepared;
  if (plan.refusals.length > 0) return { ok: false, code: "refused", refusals: plan.refusals };
  const admin = teamRoleAllows(who.role, "team.skills.review");
  const direct =
    source.scope === "personal" ||
    admin ||
    (await withTeam(deps.db, source.teamId, (tx) => buildersMayPromote(tx, source.teamId)));
  if (!direct) return request(deps.db, plan, source, who.userId);
  try {
    return {
      ok: true,
      kind: "submitted",
      registryVersionId: await submit(deps, plan, source, who.userId),
    };
  } catch (err) {
    if (err instanceof SubmitRefusedError)
      return { ok: false, code: "refused", refusals: [err.refusal] };
    throw err;
  }
}

async function request(
  db: KobeDb,
  plan: PromotionPlan,
  source: PromoteSource,
  userId: string,
): Promise<PromoteResult> {
  try {
    const id = await withTeam(db, source.teamId, async (tx) => {
      const [row] = await tx
        .insert(skillPromotionRequests)
        .values({
          teamId: source.teamId,
          skillId: source.skillId,
          version: plan.seq,
          semver: plan.semver,
          packageHash: plan.bundle.packageHash,
          requestedBy: userId,
        })
        .returning({ id: skillPromotionRequests.id });
      if (!row) throw new Error("promotion request insert returned no row");
      await recordAudit(tx, {
        action: "skill.promotion.requested",
        teamId: source.teamId,
        target: {
          requestId: row.id,
          skillId: source.skillId,
          version: plan.seq,
          semver: plan.semver,
        },
      });
      return row.id;
    });
    return { ok: true, kind: "requested", requestId: id };
  } catch (err) {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    if ((e.cause?.code ?? e.code) !== "23505") throw err;
    return {
      ok: false,
      code: "already_requested",
      message: "This version already waits for a Team admin.",
    };
  }
}

export interface PendingRequest {
  readonly id: string;
  readonly skillId: string;
  readonly version: number;
  readonly semver: string;
  readonly requestedBy: string;
  readonly createdAt: string;
}

export async function pendingRequests(db: KobeDb, teamId: string): Promise<PendingRequest[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select({
        id: skillPromotionRequests.id,
        skillId: skillPromotionRequests.skillId,
        version: skillPromotionRequests.version,
        semver: skillPromotionRequests.semver,
        requestedBy: skillPromotionRequests.requestedBy,
        createdAt: skillPromotionRequests.createdAt,
      })
      .from(skillPromotionRequests)
      .where(
        and(eq(skillPromotionRequests.teamId, teamId), eq(skillPromotionRequests.state, "pending")),
      )
      .orderBy(skillPromotionRequests.createdAt),
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

async function pending(db: KobeDb, teamId: string, id: string) {
  return (await pendingRequests(db, teamId)).find((r) => r.id === id) ?? null;
}

/** What a request would send, for the Team admin's confirmation (files, fixtures, conversation). */
export async function requestPreview(deps: PromoteDeps, teamId: string, id: string) {
  const req = await pending(deps.db, teamId, id);
  if (!req) return null;
  const source = { scope: "team" as const, teamId, skillId: req.skillId, version: req.version };
  return {
    request: req,
    prepared: await preparePromotion(deps.db, deps.store, source, req.requestedBy),
  };
}

/** A Team admin's one-click confirm: the rules are checked again, then Kobe submits. */
export async function confirmRequest(
  deps: PromoteDeps,
  teamId: string,
  id: string,
  admin: string,
): Promise<PromoteResult> {
  const state = await requestState(deps.db, teamId, id);
  if (state === null) return { ok: false, code: "not_found", message: "No such request." };
  if (state !== "pending") return CLOSED;
  const result = await confirmPending(deps, teamId, id, admin);
  // Decided by another admin since the check above (C4-M1): the plan then sees its submission
  // (a duplicate, a refusal). A request that is no longer pending always answers request_closed.
  if (result.ok || result.code === "request_closed") return result;
  return (await requestState(deps.db, teamId, id)) === "pending" ? result : CLOSED;
}

async function confirmPending(
  deps: PromoteDeps,
  teamId: string,
  id: string,
  admin: string,
): Promise<PromoteResult> {
  const preview = await requestPreview(deps, teamId, id);
  if (!preview) return CLOSED;
  const { request: req, prepared } = preview;
  if (!prepared.ok) return prepared;
  if (prepared.plan.bundle.packageHash !== (await packageHashOf(deps.db, teamId, id)))
    return { ok: false, code: "not_found", message: "The request's package changed." };
  if (prepared.plan.refusals.length > 0)
    return { ok: false, code: "refused", refusals: prepared.plan.refusals };
  const source = { scope: "team" as const, teamId, skillId: req.skillId, version: req.version };
  try {
    const versionId = await submit(deps, prepared.plan, source, req.requestedBy, {
      requestId: id,
      by: admin,
    });
    return { ok: true, kind: "submitted", registryVersionId: versionId };
  } catch (err) {
    if (err instanceof RequestClosedError) return CLOSED;
    if (err instanceof SubmitRefusedError)
      return { ok: false, code: "refused", refusals: [err.refusal] };
    throw err;
  }
}

const CLOSED = {
  ok: false,
  code: "request_closed",
  message: "Another Team admin already decided this request.",
} as const;

/** A request's state, or null when the team has no such request. */
async function requestState(db: KobeDb, teamId: string, id: string): Promise<string | null> {
  const [row] = await withTeam(db, teamId, (tx) =>
    tx
      .select({ state: skillPromotionRequests.state })
      .from(skillPromotionRequests)
      .where(and(eq(skillPromotionRequests.teamId, teamId), eq(skillPromotionRequests.id, id))),
  );
  return row?.state ?? null;
}

async function packageHashOf(db: KobeDb, teamId: string, id: string): Promise<string | null> {
  const [row] = await withTeam(db, teamId, (tx) =>
    tx
      .select({ hash: skillPromotionRequests.packageHash })
      .from(skillPromotionRequests)
      .where(and(eq(skillPromotionRequests.teamId, teamId), eq(skillPromotionRequests.id, id))),
  );
  return row?.hash ?? null;
}

export async function declineRequest(
  db: KobeDb,
  teamId: string,
  id: string,
  admin: string,
  note: string | null,
): Promise<"declined" | "not_found" | "closed"> {
  return withTeam(db, teamId, async (tx) => {
    const lock = await tx.execute<{ state: string }>(sql`
      SELECT state FROM skill_promotion_requests WHERE team_id = ${teamId} AND id = ${id} FOR UPDATE`);
    const state = lock.rows[0]?.state;
    if (state === undefined) return "not_found";
    if (state !== "pending") return "closed";
    const rows = await tx
      .update(skillPromotionRequests)
      .set({ state: "declined", decidedBy: admin, decidedAt: new Date(), note })
      .where(
        and(
          eq(skillPromotionRequests.teamId, teamId),
          eq(skillPromotionRequests.id, id),
          eq(skillPromotionRequests.state, "pending"),
        ),
      )
      .returning({ id: skillPromotionRequests.id });
    if (rows.length === 0) return "closed";
    await recordAudit(tx, {
      action: "skill.promotion.declined",
      teamId,
      target: { requestId: id },
    });
    return "declined";
  });
}
