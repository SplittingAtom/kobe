import { and, desc, eq, galleryAgentScores, installAgents, sql, type KobeDb } from "@kobe/db";
import type { EvalRecord } from "./store.js";

/**
 * Install-level Orbit scores of gallery agents (KOBE-94). Gallery agents belong to no team, so the
 * eval runs in a host team (an `orbit_evals` row with scope `gallery` is the execution record) and
 * its verdict is copied into `gallery_agent_scores`, which every team may read.
 */

export interface GalleryScore {
  readonly agentId: string;
  readonly version: number;
  readonly status: "passed" | "blocked";
  readonly attackSuccessRate: number;
  readonly attempts: number;
  readonly threshold: number;
  readonly evaluatedAt: Date;
}

/** The gallery version an eval scored (stored beside the definition when the eval starts). */
export function galleryVersionOf(record: Pick<EvalRecord, "definition">): number | null {
  const v = record.definition.galleryVersion;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** Copies a finished gallery eval's verdict (passed or blocked) to the install-level score. */
export async function recordGalleryScore(db: KobeDb, record: EvalRecord): Promise<void> {
  const version = galleryVersionOf(record);
  if (
    version === null ||
    record.attackSuccessRate === null ||
    record.attempts === null ||
    record.attackSuccesses === null ||
    (record.status !== "passed" && record.status !== "blocked")
  ) {
    return;
  }
  await db.insert(galleryAgentScores).values({
    agentId: record.agentId,
    version,
    status: record.status,
    attackSuccessRate: record.attackSuccessRate,
    attempts: record.attempts,
    attackSuccesses: record.attackSuccesses,
    threshold: record.threshold,
    report: record.report,
    evaluatedAt: record.finishedAt ?? new Date(),
  });
}

/** The newest score of each gallery agent's CURRENT version (one query; agents without one are absent). */
export async function currentGalleryScores(db: KobeDb): Promise<GalleryScore[]> {
  const rows = await db
    .selectDistinctOn([galleryAgentScores.agentId], {
      agentId: galleryAgentScores.agentId,
      version: galleryAgentScores.version,
      status: galleryAgentScores.status,
      attackSuccessRate: galleryAgentScores.attackSuccessRate,
      attempts: galleryAgentScores.attempts,
      threshold: galleryAgentScores.threshold,
      evaluatedAt: galleryAgentScores.evaluatedAt,
    })
    .from(galleryAgentScores)
    .innerJoin(
      installAgents,
      and(
        eq(installAgents.id, galleryAgentScores.agentId),
        eq(installAgents.scope, "gallery"),
        sql`${installAgents.currentVersion} = ${galleryAgentScores.version}`,
      ),
    )
    .orderBy(galleryAgentScores.agentId, desc(galleryAgentScores.evaluatedAt));
  return rows;
}

/** What the API says about a gallery score. */
export function galleryScoreView(s: GalleryScore) {
  return {
    agentId: s.agentId,
    version: s.version,
    status: s.status,
    attackSuccessRate: s.attackSuccessRate,
    attempts: s.attempts,
    threshold: s.threshold,
    evaluatedAt: s.evaluatedAt.toISOString(),
  };
}
