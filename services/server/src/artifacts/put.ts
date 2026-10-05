import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  artifactToolInputSchema,
  type ArtifactPutFrame,
  type CreateArtifactInput,
  type UpdateArtifactInput,
} from "@kobe/protocol";
import {
  and,
  artifactVersions,
  artifacts,
  eq,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { AppendError, appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { logger } from "../logger.js";
import { threadKey, type BlobStore } from "../retention/blobs.js";
import { artifactBlobKey } from "./keys.js";

/**
 * Stores one `artifact.put` the connection already verified (capability, lease, an allowed tool
 * call with the same input hash; D-3 of KOBE-55). What is left here is state-dependent and
 * re-checked in the database: the run is still active and belongs to this sandbox's user and
 * thread, an update names an artifact of the same team **and the same thread**, and a call that
 * was already applied returns its first result (unique `(team_id, tool_call_id)`).
 *
 * Order: read-only checks, upload the bytes (key derived here), then one transaction that writes
 * the rows and appends `artifact.created` / `artifact.updated` to the run's stream. An upload
 * orphaned by a refusal or a lost race is deleted again (best effort; retention deletes the
 * thread's whole tree anyway).
 */

export type PutRefusal = "run_not_active" | "artifact_not_found";

export type PutResult =
  | { readonly ok: true; readonly artifactId: string; readonly version: number }
  | {
      readonly ok: false;
      readonly code: "not_allowed" | "not_found" | "invalid_input" | "storage_failed";
      readonly message: string;
      /** Set when the refusal is an authorization one (audited by the caller). */
      readonly refusal?: PutRefusal;
    };

export interface ArtifactPutDeps {
  readonly db: KobeDb;
  /** Object storage; undefined: artifacts can't be stored (`storage_failed`). */
  readonly blobs: BlobStore | undefined;
  /** Run event cap (`WireTuning.runMaxEvents`): at the cap the event is skipped, not the artifact. */
  readonly runMaxEvents: number;
}

export interface PutTarget {
  readonly teamId: string;
  readonly userId: string;
}

const fail = (
  code: Extract<PutResult, { ok: false }>["code"],
  message: string,
  refusal?: PutRefusal,
): PutResult => ({ ok: false, code, message, ...(refusal ? { refusal } : {}) });

const RUN_ENDED = fail(
  "not_allowed",
  "The run has ended, so the artifact was not stored.",
  "run_not_active",
);
const NOT_FOUND = fail("not_found", "No such artifact in this conversation.", "artifact_not_found");

class RunEndedError extends Error {}
class ArtifactMissingError extends Error {}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.cause?.code ?? e.code;
  return typeof code === "string" ? code : undefined;
}

/** The run is active, in this thread, and owned by the sandbox's user. */
async function runActive(tx: KobeTx, target: PutTarget, frame: ArtifactPutFrame): Promise<boolean> {
  const res = await tx.execute<{ status: string }>(sql`
    SELECT r.status FROM runs r
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${target.teamId} AND r.id = ${frame.run_id}
       AND r.thread_id = ${frame.thread_id}
       AND t.team_id = ${target.teamId} AND t.owner_user_id = ${target.userId}`);
  const status = res.rows[0]?.status;
  return status === "running" || status === "waiting_approval";
}

async function existingResult(tx: KobeTx, teamId: string, toolCallId: string) {
  const [row] = await tx
    .select({ artifactId: artifactVersions.artifactId, version: artifactVersions.version })
    .from(artifactVersions)
    .where(and(eq(artifactVersions.teamId, teamId), eq(artifactVersions.toolCallId, toolCallId)));
  return row;
}

async function artifactInThread(tx: KobeTx, teamId: string, threadId: string, id: string) {
  const [row] = await tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(eq(artifacts.teamId, teamId), eq(artifacts.id, id), eq(artifacts.threadId, threadId)),
    );
  return row !== undefined;
}

type Input =
  | { readonly tool: "create_artifact"; readonly input: CreateArtifactInput }
  | { readonly tool: "update_artifact"; readonly input: UpdateArtifactInput };

function parseInput(frame: ArtifactPutFrame): Input | undefined {
  if (frame.tool === "create_artifact") {
    const parsed = artifactToolInputSchema.create_artifact.safeParse(frame.input);
    return parsed.success ? { tool: frame.tool, input: parsed.data } : undefined;
  }
  const parsed = artifactToolInputSchema.update_artifact.safeParse(frame.input);
  return parsed.success ? { tool: frame.tool, input: parsed.data } : undefined;
}

interface Written {
  readonly artifactId: string;
  readonly version: number;
}

/** Writes the rows and the event in the caller's transaction. */
async function writeRows(
  tx: KobeTx,
  deps: ArtifactPutDeps,
  target: PutTarget,
  frame: ArtifactPutFrame,
  call: Input,
  stored: { artifactId: string; blobRef: string; size: number; sha256: string },
): Promise<Written> {
  if (!(await runActive(tx, target, frame))) throw new RunEndedError();
  const { teamId } = target;
  let version = 1;
  let title: string | undefined;
  if (call.tool === "create_artifact") {
    const { input } = call;
    await tx.insert(artifacts).values({
      teamId,
      id: stored.artifactId,
      threadId: frame.thread_id,
      createdBy: target.userId,
      kind: input.kind,
      title: input.title,
      language: input.language ?? null,
    });
    title = input.title;
  } else {
    const [row] = await tx
      .update(artifacts)
      .set({
        currentVersion: sql`${artifacts.currentVersion} + 1`,
        updatedAt: sql`now()`,
        ...(call.input.title === undefined ? {} : { title: call.input.title }),
      })
      .where(
        and(
          eq(artifacts.teamId, teamId),
          eq(artifacts.id, stored.artifactId),
          eq(artifacts.threadId, frame.thread_id),
        ),
      )
      .returning({ version: artifacts.currentVersion });
    if (!row) throw new ArtifactMissingError();
    version = row.version;
    title = call.input.title;
  }
  await tx.insert(artifactVersions).values({
    teamId,
    artifactId: stored.artifactId,
    version,
    threadId: frame.thread_id,
    blobRef: stored.blobRef,
    sizeBytes: stored.size,
    sha256: stored.sha256,
    runId: frame.run_id,
    toolCallId: frame.tool_call_id,
  });
  await appendEvent(tx, deps, teamId, frame, call, stored.artifactId, version, title);
  return { artifactId: stored.artifactId, version };
}

async function appendEvent(
  tx: KobeTx,
  deps: ArtifactPutDeps,
  teamId: string,
  frame: ArtifactPutFrame,
  call: Input,
  artifactId: string,
  version: number,
  title: string | undefined,
): Promise<void> {
  const run = await tx.execute<{ last_seq: number }>(sql`
    SELECT last_seq FROM runs WHERE team_id = ${teamId} AND id = ${frame.run_id}`);
  // Keep room for the terminal event (as the ingest does); the artifact itself is stored anyway.
  if ((run.rows[0]?.last_seq ?? deps.runMaxEvents) + 2 > deps.runMaxEvents) {
    logger.warn({ run_id: frame.run_id }, "artifact event skipped: the run is at its event cap");
    return;
  }
  const event =
    call.tool === "create_artifact"
      ? {
          type: "artifact.created" as const,
          payload: {
            artifact_id: artifactId,
            tool_call_id: frame.tool_call_id,
            kind: call.input.kind,
            title: title ?? call.input.title,
            version: 1,
          },
        }
      : {
          type: "artifact.updated" as const,
          payload: {
            artifact_id: artifactId,
            tool_call_id: frame.tool_call_id,
            ...(title === undefined ? {} : { title }),
            version,
          },
        };
  try {
    await appendRunEventsInTx(tx, teamId, frame.run_id, [event]);
  } catch (err) {
    if (err instanceof AppendError && err.code === "run_finished") throw new RunEndedError();
    throw err;
  }
}

async function discard(blobs: BlobStore, key: string): Promise<void> {
  try {
    await blobs.objects.delete([key]);
  } catch (err) {
    logger.warn({ err }, "artifact: could not delete an orphaned upload");
  }
}

export async function putArtifact(
  deps: ArtifactPutDeps,
  target: PutTarget,
  frame: ArtifactPutFrame,
): Promise<PutResult> {
  const { teamId } = target;
  const call = parseInput(frame);
  if (!call) return fail("invalid_input", "The artifact input is not valid.");
  const blobs = deps.blobs;
  if (!blobs) return fail("storage_failed", "Artifact storage is not available.");

  // 1. Read-only checks, and the idempotent replay of a call already applied.
  const pre = await withTeam(deps.db, teamId, async (tx) => {
    const prior = await existingResult(tx, teamId, frame.tool_call_id);
    if (prior) return { prior } as const;
    if (!(await runActive(tx, target, frame))) return { refused: RUN_ENDED } as const;
    if (
      call.tool === "update_artifact" &&
      !(await artifactInThread(tx, teamId, frame.thread_id, call.input.artifact_id))
    ) {
      return { refused: NOT_FOUND } as const;
    }
    return {} as const;
  });
  if ("prior" in pre && pre.prior) return { ok: true, ...pre.prior };
  if ("refused" in pre && pre.refused) return pre.refused;

  // 2. Upload under a server-derived key.
  const artifactId = call.tool === "create_artifact" ? randomUUID() : call.input.artifact_id;
  const bytes = Buffer.from(call.input.content, "utf8");
  const key = artifactBlobKey(blobs.prefix, teamId, frame.thread_id, artifactId);
  if (!threadKey(blobs.prefix, teamId, frame.thread_id, key)) {
    return fail("storage_failed", "Artifact storage is not available.");
  }
  try {
    await blobs.objects.put(key, Readable.from([bytes]), bytes.length);
  } catch (err) {
    logger.error({ err, team_id: teamId }, "artifact upload failed");
    return fail("storage_failed", "The artifact could not be stored. Try again.");
  }

  // 3. Rows and event in one transaction.
  const stored = {
    artifactId,
    blobRef: key,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    const written = await withAppendTx(deps.db, teamId, (tx) =>
      writeRows(tx, deps, target, frame, call, stored),
    );
    return { ok: true, ...written };
  } catch (err) {
    await discard(blobs, key);
    if (
      err instanceof RunEndedError ||
      (err instanceof AppendError && err.code === "run_finished")
    ) {
      return RUN_ENDED;
    }
    if (err instanceof ArtifactMissingError) return NOT_FOUND;
    if (pgCode(err) === "23505") {
      // A concurrent copy of the same tool call won: answer with its result.
      const prior = await withTeam(deps.db, teamId, (tx) =>
        existingResult(tx, teamId, frame.tool_call_id),
      );
      if (prior) return { ok: true, ...prior };
    }
    logger.error({ err, team_id: teamId }, "artifact write failed");
    return fail("storage_failed", "The artifact could not be stored. Try again.");
  }
}
