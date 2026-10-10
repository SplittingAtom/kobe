import { createHash, randomUUID } from "node:crypto";
import {
  APPROVAL_TTL_MS,
  PROJECT_FILE_MAX_BYTES,
  uploadFileNameSchema,
  type PolicyDecision,
  type ProjectFile,
  type ProposeProjectFileInput,
} from "@kobe/protocol";
import { and, eq, projectFiles, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import {
  approvalHolds,
  hasApproval,
  noPromptCode,
  recordDeniedWrite,
} from "../approvals/server-write.js";
import type { ApprovalVerifier } from "../approvals/verify.js";
import { manifestPath } from "../files/share.js";
import { canAccessProject } from "../memory/access.js";
import type { BlobStore } from "../retention/blobs.js";
import type { ApprovalBroker } from "../sandbox-wire/types.js";
import { resolveMime, SNIFF_BYTES } from "../uploads/mime.js";
import { currentEntry } from "../workspace-sync/store.js";
import {
  commitProjectFile,
  projectFileKey,
  projectFilePath,
  toProjectFile,
  type ProjectFileDeps,
} from "./files.js";
import type { ProjectMounts } from "./mounts.js";

/**
 * The server side of the agent's `propose_project_file` (KOBE-162, ac-2; contract KOBE-159). The
 * connection has already checked what only it knows (capability, run lease, and that this exact
 * call, with the same input hash, was allowed here, D-3); this module re-checks everything in the
 * database and does the work. Nothing the sandbox says about the file is trusted: the bytes are
 * the workspace manifest's own object for the pushed path, and only while its live row still has
 * the `rev`, `sha256` and size of the push.
 *
 * A proposal never adds anything by itself. The project is the thread's own and the user must be
 * a member; the add needs the signed approval of exactly this call (approvals/verify.ts): if the
 * policy check already got one it is verified and consumed now, otherwise an approval is asked
 * through the normal broker, the sandbox is answered `pending_approval`, and on approval the
 * signature is verified over the same canonical input and the blob is copied server-side into the
 * project's files. Denied, expired or ended: nothing is written. Runs that never wait for people
 * (`auto` mode, scheduled runs; D32) are refused at once and the skip is recorded. No approval
 * verifier configured means no add (closed).
 */
export interface ProposeDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  readonly approvals: ApprovalBroker;
  readonly verifier: ApprovalVerifier | undefined;
  readonly mounts: ProjectMounts | undefined;
  readonly files: Pick<ProjectFileDeps, "maxFileBytes" | "teamQuotaDefaultBytes">;
  readonly runMaxEvents: number;
  readonly log: Logger;
}

export type ProposeRefusal =
  | "run_not_active"
  | "not_allowed"
  | "no_project"
  | "not_a_member"
  | "path_mismatch"
  | "not_synced"
  | "not_found"
  | "too_large"
  | "quota_exceeded"
  | "already_exists"
  | "approval_denied";

export type ProposeReply =
  | {
      readonly ok: true;
      readonly op: "project_file_propose";
      readonly status: "pending_approval" | "applied";
      readonly proposal_id: string;
      readonly project_id: string;
      readonly path: string;
      readonly file?: ProjectFile;
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface ProposeRequest {
  readonly teamId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly connectionId: string;
  readonly toolCallId: string;
  readonly input: ProposeProjectFileInput;
  readonly workspace: {
    readonly path: string;
    readonly rev: number;
    readonly sha256: string;
    readonly size: number;
  };
  /** Aborts when the connection or run ends (resolves a pending approval as denied). */
  readonly signal: AbortSignal;
  /** Called for each refusal the caller should audit (this module never audits refusals itself). */
  readonly refused: (reason: ProposeRefusal) => void;
}

export interface ProposeOutcome {
  readonly reply: Promise<ProposeReply>;
  /** Settles when all work is over (an add after `pending_approval` outlives `reply`). */
  readonly done: Promise<void>;
}

const TOOL = "propose_project_file";
const fail = (code: string, message: string): ProposeReply => ({
  ok: false,
  error: { code, message },
});
const NOT_ACTIVE = fail("not_allowed", "The run has ended, so nothing was added.");
const NO_PROJECT = fail("not_in_project", "This conversation is not in a project.");
const NOT_MEMBER = fail("not_allowed", "You are not a member of this project.");
const NOT_APPROVED = fail("not_allowed", "This file was not approved.");
const STORAGE = fail("storage_failed", "The file could not be added. Try again.");

/** A stable id for this call's proposal: the contract wants one; no table stores proposals. */
export function proposalId(runId: string, toolCallId: string): string {
  const h = createHash("sha256").update(`${runId}\0${toolCallId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Gate =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly target: string;
    }
  | { readonly ok: false; readonly reason: ProposeRefusal; readonly reply: ProposeReply };

const refuse = (reason: ProposeRefusal, reply: ProposeReply): Gate => ({
  ok: false,
  reason,
  reply,
});

/** Pure checks of the frame against the install's limits. */
function checkFrame(
  deps: ProposeDeps,
  req: ProposeRequest,
): { target: string } | { reason: ProposeRefusal; reply: ProposeReply } {
  const path = manifestPath(req.input.path);
  if (path === undefined || path !== req.workspace.path) {
    return {
      reason: "path_mismatch",
      reply: fail("not_allowed", "The file differs from the call that was allowed."),
    };
  }
  const base = path.slice(path.lastIndexOf("/") + 1);
  const name = uploadFileNameSchema.safeParse(req.input.name ?? base);
  const target = name.success ? projectFilePath(req.input.folder, name.data) : undefined;
  if (target === undefined) {
    return {
      reason: "not_allowed",
      reply: fail("invalid_input", "The file name or folder is not valid."),
    };
  }
  if (req.workspace.size > Math.min(PROJECT_FILE_MAX_BYTES, deps.files.maxFileBytes)) {
    return {
      reason: "too_large",
      reply: fail("too_large", "This file is larger than a project file may be."),
    };
  }
  return { target };
}

/** Run active and owned by the caller, the thread's project; membership; the pushed entry. */
async function gate(tx: KobeTx, deps: ProposeDeps, req: ProposeRequest): Promise<Gate> {
  const checked = checkFrame(deps, req);
  if ("reason" in checked) return refuse(checked.reason, checked.reply);
  const run = await tx.execute<{ status: string; project_id: string | null }>(sql`
    SELECT r.status, t.project_id FROM runs r
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${req.teamId} AND r.id = ${req.runId} AND r.thread_id = ${req.threadId}
       AND t.owner_user_id = ${req.userId}`);
  const row = run.rows[0];
  if (row?.status !== "running" && row?.status !== "waiting_approval") {
    return refuse("run_not_active", NOT_ACTIVE);
  }
  if (row.project_id === null) return refuse("no_project", NO_PROJECT);
  if (!(await canAccessProject(tx, req.teamId, req.userId, row.project_id))) {
    return refuse("not_a_member", NOT_MEMBER);
  }
  return { ok: true, projectId: row.project_id, target: checked.target };
}

/** The workspace object for the push, only while its live row is exactly what was pushed. */
async function pushedBlob(
  tx: KobeTx,
  req: ProposeRequest,
): Promise<{ blobKey: string } | { reason: ProposeRefusal; reply: ProposeReply }> {
  const entry = await currentEntry(tx, req, req.workspace.path);
  if (!entry) {
    return { reason: "not_found", reply: fail("not_found", "No such file in the workspace copy.") };
  }
  const ref = req.workspace;
  if (
    entry.deleted ||
    entry.blobKey === null ||
    entry.rev !== ref.rev ||
    entry.sha256 !== ref.sha256 ||
    entry.size !== ref.size
  ) {
    return {
      reason: "not_synced",
      reply: fail("not_synced", "The file changed or was not saved to the workspace copy."),
    };
  }
  return { blobKey: entry.blobKey };
}

/** The file this very proposal already added (a repeated frame answers it again). */
async function replayOf(tx: KobeTx, req: ProposeRequest, projectId: string, target: string) {
  const [row] = await tx
    .select()
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.teamId, req.teamId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.path, target),
        eq(projectFiles.sha256, req.workspace.sha256),
        eq(projectFiles.source, "proposal"),
        eq(projectFiles.addedBy, req.userId),
      ),
    );
  return row;
}

const applied = (req: ProposeRequest, projectId: string, file: ProjectFile): ProposeReply => ({
  ok: true,
  op: "project_file_propose",
  status: "applied",
  proposal_id: proposalId(req.runId, req.toolCallId),
  project_id: projectId,
  path: file.path,
  file,
});

const OUTCOME_REFUSALS = {
  already_exists: ["already_exists", "The project already has a file with that name."],
  quota_exceeded: ["quota_exceeded", "Your team has no storage left for this file."],
  project_full: ["quota_exceeded", "The project already holds the most files it can."],
  archived: ["not_allowed", "The project is archived."],
  file_too_large: ["too_large", "This file is larger than a project file may be."],
  invalid_path: ["not_allowed", "The file name or folder is not valid."],
  storage_failed: ["storage_failed", "The file could not be added. Try again."],
} as const;

/** After approval: gate again, copy the blob server-side, row + audit; then mount for members. */
async function apply(deps: ProposeDeps, req: ProposeRequest, blobs: BlobStore) {
  const pre = await withTeam(deps.db, req.teamId, async (tx) => {
    const g = await gate(tx, deps, req);
    if (!g.ok) return g;
    const prior = await replayOf(tx, req, g.projectId, g.target);
    if (prior) return { replay: toProjectFile(prior), projectId: g.projectId } as const;
    const blob = await pushedBlob(tx, req);
    if ("reason" in blob) return refuse(blob.reason, blob.reply);
    return { ...g, blobKey: blob.blobKey } as const;
  });
  if (!("ok" in pre) && "replay" in pre) {
    return { reply: applied(req, pre.projectId, pre.replay) } as const;
  }
  if ("ok" in pre && !pre.ok) return { reply: pre.reply, reason: pre.reason } as const;
  if (!("blobKey" in pre)) return { reply: STORAGE } as const;

  const id = randomUUID();
  const key = projectFileKey(blobs, req.teamId, pre.projectId, id);
  let mime: string;
  try {
    await blobs.objects.copy(pre.blobKey, key);
    mime = resolveMime(await head(blobs, key), undefined);
  } catch (err) {
    deps.log.error({ err, team_id: req.teamId }, "propose_project_file copy failed");
    await blobs.objects.delete([key]).catch(() => undefined);
    return { reply: STORAGE } as const;
  }
  const outcome = await commitProjectFile(
    { db: deps.db, blobs, ...deps.files },
    blobs,
    { teamId: req.teamId, projectId: pre.projectId, userId: req.userId },
    {
      id,
      path: pre.target,
      size: req.workspace.size,
      sha256: req.workspace.sha256,
      mime,
      blobRef: key,
      source: "proposal",
    },
  );
  if (!outcome.ok) {
    const [reason, message] = OUTCOME_REFUSALS[outcome.error];
    const refusal = reason === "storage_failed" ? undefined : (reason as ProposeRefusal);
    return { reply: fail(reason, message), ...(refusal ? { reason: refusal } : {}) } as const;
  }
  await deps.mounts?.reconcileProject(req.teamId, pre.projectId);
  return { reply: applied(req, pre.projectId, outcome.file) } as const;
}

async function head(blobs: BlobStore, key: string): Promise<Uint8Array> {
  const object = await blobs.objects.get(key);
  if (!object) throw new Error("project file copy is missing");
  const chunks: Buffer[] = [];
  let have = 0;
  try {
    for await (const chunk of object.body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      have += chunk.length;
      if (have >= SNIFF_BYTES) break;
    }
  } finally {
    object.body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, SNIFF_BYTES);
}

const approvalDecision = (): Extract<PolicyDecision, { effect: "require_approval" }> => ({
  effect: "require_approval",
  // The broker sets the real expiry (1 h, D29); this one is only the engine's field.
  expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  risk: "write",
  reasons: [
    {
      code: "risk_write",
      stage: "risk_class",
      message:
        "propose_project_file adds a file to the project's shared files, which needs your approval.",
    },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `project.file_propose`: see the module header. Never throws. */
export function proposeProjectFile(deps: ProposeDeps, req: ProposeRequest): ProposeOutcome {
  const answer = deferred<ProposeReply>();
  const call = {
    teamId: req.teamId,
    userId: req.userId,
    runId: req.runId,
    toolCallId: req.toolCallId,
  };
  const finish = (result: Awaited<ReturnType<typeof apply>>): void => {
    if ("reason" in result && result.reason) req.refused(result.reason);
    answer.resolve(result.reply);
  };
  const done = (async () => {
    const blobs = deps.blobs;
    if (!blobs) {
      answer.resolve(STORAGE);
      return;
    }
    // Early gate: a non-member or a stale push never creates an approval card; a repeat of a
    // call that was already added answers it again.
    const early = await withTeam(deps.db, req.teamId, async (tx) => {
      const g = await gate(tx, deps, req);
      if (!g.ok) return g;
      const prior = await replayOf(tx, req, g.projectId, g.target);
      if (prior) return { prior: toProjectFile(prior), projectId: g.projectId } as const;
      const blob = await pushedBlob(tx, req);
      return "reason" in blob ? refuse(blob.reason, blob.reply) : g;
    });
    if ("prior" in early) {
      answer.resolve(applied(req, early.projectId, early.prior));
      return;
    }
    if (!early.ok) {
      req.refused(early.reason);
      answer.resolve(early.reply);
      return;
    }
    if (await hasApproval(deps.db, call)) {
      // The policy check already asked: add only if that signed approval covers this input.
      if (await approvalHolds(deps.verifier, call, TOOL, req.input)) {
        finish(await apply(deps, req, blobs));
      } else {
        req.refused("approval_denied");
        answer.resolve(NOT_APPROVED);
      }
      return;
    }
    // D32: a run that never waits for a person is refused at once and the skip is recorded.
    const noPrompt = await noPromptCode(deps.db, call);
    if (noPrompt) {
      await recordDeniedWrite(deps.db, deps.log, call, TOOL, deps.runMaxEvents, noPrompt);
      req.refused("approval_denied");
      answer.resolve(
        fail("not_allowed", "This run does not wait for approvals, so the file was not added."),
      );
      return;
    }
    const outcome = await deps.approvals.request(
      {
        teamId: req.teamId,
        userId: req.userId,
        connectionId: req.connectionId,
        runId: req.runId,
        threadId: req.threadId,
        toolCallId: req.toolCallId,
        tool: TOOL,
        input: req.input as unknown as Record<string, unknown>,
        decision: approvalDecision(),
        signal: req.signal,
      },
      () =>
        answer.resolve({
          ok: true,
          op: "project_file_propose",
          status: "pending_approval",
          proposal_id: proposalId(req.runId, req.toolCallId),
          project_id: early.projectId,
          path: early.target,
        }),
    );
    if (
      outcome.decision === "deny" ||
      !(await approvalHolds(deps.verifier, call, TOOL, req.input))
    ) {
      req.refused("approval_denied");
      answer.resolve(
        outcome.decision === "deny" ? fail("not_allowed", outcome.message) : NOT_APPROVED,
      );
      return;
    }
    // Only reaches the sandbox when the approval was immediate; otherwise `pending_approval` went first.
    finish(await apply(deps, req, blobs));
  })().catch((err: unknown) => {
    deps.log.error({ err, run_id: req.runId }, "propose_project_file failed");
    answer.resolve(STORAGE);
  });
  return { reply: answer.promise, done };
}
