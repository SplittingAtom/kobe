import { createHash, randomUUID } from "node:crypto";
import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import {
  EVENT_PAYLOAD_MAX_BYTES,
  jsonByteLength,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILES_MAX,
  workspaceToolPath,
  type FileEditProposeFrame,
  type FileEditProposedPayload,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import type { Logger } from "pino";
import type { AllowedVerdict } from "../artifacts/allowed.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { loadAccess } from "../projects/access.js";
import { clashesInTree } from "../projects/from-proposal.js";
import { headOf, loadTree } from "../projects/tree.js";
import { pathIsTaken } from "../workspace-files/browse.js";
import { ancestorsOf, areaOf, isInternalPath, isReadOnlyPath } from "../workspace-files/paths.js";
import { currentEntry } from "../workspace-sync/store.js";
import type { SandboxTarget } from "./types.js";

/**
 * `file.edit_propose` (KOBE-462, file-editor.ts; spec FE8) on one connection: accepted only if it
 * announced `file_edits`, the run is leased here and active, and this `propose_file_edit` call
 * was allowed here with the same canonical input hash, taken once. Writes no file: the proposal is
 * recorded as the run's `file.edit_proposed` event (the web's only source for the diff), based on
 * the synced copy's current version, and answered `awaiting_user`.
 */
export interface FileEditProposeConnection {
  readonly db: KobeDb;
  readonly target: SandboxTarget;
  readonly runMaxEvents: number;
  readonly log: Pick<Logger, "error" | "warn">;
  readonly hasCapability: boolean;
  /** `#checkToolRun` for this frame; "violation" was already answered and the frame dropped. */
  readonly runCheck: () => "ok" | "ended" | "violation";
  /** Takes the allowance (single use): a second frame for the call is "replayed". */
  readonly verdict: () => AllowedVerdict | "replayed";
  send(frame: ServerToSandboxFrame): boolean;
}

export type ProposeOutcome =
  | { readonly ok: true; readonly path: string; readonly baseSha256?: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

const refused = (code: string, message: string): ProposeOutcome => ({ ok: false, code, message });

export function onFileEditPropose(c: FileEditProposeConnection, frame: FileEditProposeFrame): void {
  const answer = (outcome: ProposeOutcome) =>
    c.send(
      outcome.ok
        ? {
            v: 1,
            type: "file.edit_propose_result",
            request_id: frame.request_id,
            ok: true,
            op: "file_edit_propose",
            status: "awaiting_user",
            path: outcome.path,
            ...(outcome.baseSha256 === undefined ? {} : { base_sha256: outcome.baseSha256 }),
          }
        : {
            v: 1,
            type: "file.edit_propose_result",
            request_id: frame.request_id,
            ok: false,
            error: { code: outcome.code, message: outcome.message },
          },
    );
  if (!c.hasCapability) {
    answer(refused("not_allowed", "This sandbox did not announce file edits."));
    return;
  }
  // A skill eval's sandbox (KOBE-325) never reaches the member's workspace (also denied by policy).
  if (c.target.evalThreadId !== undefined) {
    answer(refused("not_allowed", "Skill evals never propose edits to the member's files."));
    return;
  }
  const check = c.runCheck();
  if (check === "violation") return;
  if (check === "ended") {
    answer(refused("not_allowed", "The run has ended, so the edit was not proposed."));
    return;
  }
  const verdict = c.verdict();
  if (verdict !== "ok") {
    c.log.warn({ run_id: frame.run_id, verdict, security: true }, "file.edit_propose refused");
    answer(
      refused(
        "not_allowed",
        verdict === "input_mismatch"
          ? "The edit differs from the call that was allowed."
          : verdict === "replayed"
            ? "This tool call was already used to propose an edit."
            : "This tool call was not allowed for this tool.",
      ),
    );
    return;
  }
  void proposeFileEdit(c.db, c.target, frame, c.runMaxEvents)
    .catch((err: unknown): ProposeOutcome => {
      c.log.error({ err, run_id: frame.run_id }, "file.edit_propose failed");
      return refused("storage_failed", "The proposal could not be recorded. Try again.");
    })
    .then(answer);
}

/**
 * Checks the path and records the proposal. Nothing is pushed or written. Two places (KOBE-591,
 * projects-in-conversations PE2):
 * - the member's own files (outside `projects/` and `uploads/`): based on the synced copy, which
 *   the member's editor would load now; a path with no synced file is a new file (no base);
 * - files of the conversation's own project (`projects/<slug>/...`), only while the run's owner
 *   may edit it (PE1, their role now): based on the project's head (`base_commit_seq`) and the
 *   file at that head (`base_sha256`, absent for a new file), within the project path rules and
 *   limits. Other projects and thread uploads stay read-only.
 */
export async function proposeFileEdit(
  db: KobeDb,
  target: SandboxTarget,
  frame: FileEditProposeFrame,
  runMaxEvents: number,
): Promise<ProposeOutcome> {
  const path = workspaceToolPath(frame.input.path);
  if (path === undefined) {
    return refused("invalid_path", "Name a file under /workspace.");
  }
  if (isInternalPath(path)) return refused("not_found", "There is no such file in the workspace.");
  const area = areaOf(path);
  if (area === "uploads" && isReadOnlyPath(path)) {
    return refused("read_only", "Thread uploads are read-only; propose a copy elsewhere instead.");
  }
  return withAppendTx(db, target.teamId, async (tx): Promise<ProposeOutcome> => {
    const based =
      area === "projects"
        ? await projectBase(tx, target, frame, path)
        : await workspaceBase(tx, target, path);
    if ("ok" in based) return based;
    const payload: FileEditProposedPayload = {
      tool_call_id: frame.tool_call_id,
      proposal_id: randomUUID(),
      path,
      ...based,
      content: frame.input.content,
      summary: frame.input.summary,
    };
    if (jsonByteLength(payload) > EVENT_PAYLOAD_MAX_BYTES) {
      return refused("too_large", "The proposed content is too large to review.");
    }
    const run = await tx.execute<{ last_seq: number }>(sql`
      SELECT last_seq FROM runs WHERE team_id = ${target.teamId} AND id = ${frame.run_id}`);
    if ((run.rows[0]?.last_seq ?? runMaxEvents) + 2 > runMaxEvents) {
      return refused("storage_failed", "This run has recorded too much to take a proposal.");
    }
    await appendRunEventsInTx(tx, target.teamId, frame.run_id, [
      { type: "file.edit_proposed", payload },
    ]);
    return {
      ok: true,
      path,
      ...(based.base_sha256 === undefined ? {} : { baseSha256: based.base_sha256 }),
    };
  });
}

type Base = Pick<FileEditProposedPayload, "base_sha256" | "project_id" | "base_commit_seq">;

const OTHER_PROJECT = refused(
  "read_only",
  "Only files of this conversation's project can be proposed; other projects are read-only.",
);

/** My files: the synced copy, or a new file where nothing (no file, no folder) is. */
async function workspaceBase(
  tx: KobeTx,
  target: SandboxTarget,
  path: string,
): Promise<Base | ProposeOutcome> {
  const owner = { teamId: target.teamId, userId: target.userId };
  const entry = await currentEntry(tx, owner, path);
  if (entry && !entry.deleted && entry.sha256 !== undefined) return { base_sha256: entry.sha256 };
  if (await pathIsTaken(tx, owner, path, ancestorsOf(path))) {
    return refused("invalid_path", "That path is a folder or lies inside a file; name a file.");
  }
  return {};
}

/** The conversation's project, the owner's role now, and the head (PE1-PE3). */
async function projectBase(
  tx: KobeTx,
  target: SandboxTarget,
  frame: FileEditProposeFrame,
  path: string,
): Promise<Base | ProposeOutcome> {
  const parts = path.split("/");
  const slug = parts[1];
  const rel = parts.slice(2).join("/");
  if (slug === undefined || rel === "") return OTHER_PROJECT;
  const res = await tx.execute<{ project_id: string | null }>(sql`
    SELECT t.project_id FROM runs r
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${target.teamId} AND r.id = ${frame.run_id}
       AND r.thread_id = ${frame.thread_id} AND t.team_id = ${target.teamId}
       AND t.owner_user_id = ${target.userId}`);
  const projectId = res.rows[0]?.project_id ?? null;
  if (projectId === null) return OTHER_PROJECT;
  const owner = { teamId: target.teamId, userId: target.userId };
  const access = await loadAccess(tx, owner, projectId);
  if (!access || access.project.slug !== slug) return OTHER_PROJECT;
  if (!access.can.edit) {
    return refused("read_only", `You can read ${access.project.name} but not change it.`);
  }
  if (access.project.archivedAt !== null) {
    return refused("read_only", `${access.project.name} is archived; its files stay as they are.`);
  }
  const head = await headOf(tx, target.teamId, projectId);
  const tree = await loadTree(tx, target.teamId, head?.id ?? null);
  const current = tree.get(rel);
  const base = { project_id: projectId, base_commit_seq: head?.seq ?? 0 };
  if (current) {
    if (current.sha256 === sha256Of(frame.input.content)) {
      return refused("not_allowed", "The proposed content is the file's current content.");
    }
    return { ...base, base_sha256: current.sha256 };
  }
  if (rel.slice(rel.lastIndexOf("/") + 1).includes(".conflict-") || clashesInTree(tree, rel)) {
    return refused("invalid_path", "A project can't take a file with that name there.");
  }
  if (tree.size >= PROJECT_FILES_MAX) {
    return refused("project_full", `A project holds at most ${PROJECT_FILES_MAX} files.`);
  }
  if (Buffer.byteLength(frame.input.content) > PROJECT_FILE_MAX_BYTES) {
    return refused("too_large", "The proposed content is larger than a project file may be.");
  }
  return base;
}

const sha256Of = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");
