import type { ArtifactDetail, ArtifactKind, ArtifactSummary } from "@kobe/protocol";
import { and, artifactVersions, artifacts, asc, eq, type KobeTx } from "@kobe/db";
import { findThread, type Viewer } from "../threads/repository.js";

/**
 * Reads behind `GET /v1/artifacts` (D-6 of KOBE-55). An artifact is readable exactly when its
 * thread is (`findThread`: own threads, or shared to one of the viewer's projects), so an unknown
 * id, another team's artifact and another user's private thread are indistinguishable (null).
 * Every query names the team (RLS also enforces it).
 */

const COLUMNS = {
  id: artifacts.id,
  threadId: artifacts.threadId,
  kind: artifacts.kind,
  title: artifacts.title,
  language: artifacts.language,
  currentVersion: artifacts.currentVersion,
  createdAt: artifacts.createdAt,
  updatedAt: artifacts.updatedAt,
};

type Row = {
  id: string;
  threadId: string;
  kind: string;
  title: string;
  language: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

function summary(row: Row): ArtifactSummary {
  return {
    id: row.id,
    thread_id: row.threadId,
    kind: row.kind as ArtifactKind,
    title: row.title,
    language: row.language,
    current_version: row.currentVersion,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listArtifacts(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
): Promise<ArtifactSummary[] | null> {
  if (!(await findThread(tx, viewer, threadId))) return null;
  const rows = await tx
    .select(COLUMNS)
    .from(artifacts)
    .where(and(eq(artifacts.teamId, viewer.teamId), eq(artifacts.threadId, threadId)))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
  return rows.map(summary);
}

/** The artifact, if its thread is readable by the viewer. */
export async function findArtifact(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
): Promise<ArtifactSummary | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(artifacts)
    .where(and(eq(artifacts.teamId, viewer.teamId), eq(artifacts.id, id)));
  if (!row || !(await findThread(tx, viewer, row.threadId))) return null;
  return summary(row);
}

export async function artifactDetail(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
): Promise<ArtifactDetail | null> {
  const found = await findArtifact(tx, viewer, id);
  if (!found) return null;
  const versions = await tx
    .select({
      version: artifactVersions.version,
      sizeBytes: artifactVersions.sizeBytes,
      createdAt: artifactVersions.createdAt,
    })
    .from(artifactVersions)
    .where(and(eq(artifactVersions.teamId, viewer.teamId), eq(artifactVersions.artifactId, id)))
    .orderBy(asc(artifactVersions.version));
  return {
    ...found,
    versions: versions.map((v) => ({
      version: v.version,
      size_bytes: v.sizeBytes,
      created_at: v.createdAt.toISOString(),
    })),
  };
}

/** One version's object key, for an artifact the viewer may read. */
export async function findVersionBlob(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  version: number,
): Promise<{ artifact: ArtifactSummary; blobRef: string; sizeBytes: number } | null> {
  const artifact = await findArtifact(tx, viewer, id);
  if (!artifact) return null;
  const [row] = await tx
    .select({ blobRef: artifactVersions.blobRef, sizeBytes: artifactVersions.sizeBytes })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.teamId, viewer.teamId),
        eq(artifactVersions.artifactId, id),
        eq(artifactVersions.version, version),
      ),
    );
  return row ? { artifact, ...row } : null;
}
