import {
  APPROVAL_TTL_MS,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_LINES,
  MEMORY_RECALL_MAX_FILES,
  type MemoryScope,
  type MemoryToolsResponse,
  type PolicyDecision,
  type RecallInput,
  type RememberInput,
  type RunMemoryContext,
} from "@kobe/protocol";
import {
  and,
  eq,
  memoryDocVersions,
  memoryDocs,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import { loadApprovalForCall } from "../approvals/store.js";
import type { ApprovalVerifier } from "../approvals/verify.js";
import { recordAudit } from "../audit/record.js";
import { AppendError, appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import type { BlobStore } from "../retention/blobs.js";
import type { ApprovalBroker } from "../sandbox-wire/types.js";
import { canAccessProject } from "./access.js";
import {
  MemoryStorageError,
  listMemory,
  readCurrent,
  writeMemory,
  type DocRow,
  type MemoryTarget,
} from "./store.js";
import { readSwitches } from "./switches.js";

/**
 * The server side of the sandbox's `remember` and `recall` tools (KOBE-156, spec D24; contract
 * KOBE-153). The connection has already checked what only it knows (capability, run lease, and for
 * `memory.put` that this `remember` call was allowed here with the same input hash, D-3); this
 * module re-checks everything in the database and does the work.
 *
 * - **Personal** (`user`) writes apply at once and append `memory.updated` (Undo, KOBE-153).
 * - **Project** writes need the signed approval of exactly this call (approvals/verify.ts): if the
 *   policy check already got one it is verified and consumed now; otherwise an approval is asked
 *   through the normal broker, the sandbox is answered `pending_approval`, and the write is applied
 *   (and `memory.updated` appended) when it is approved. A denied, expired or ended approval
 *   writes nothing.
 * - The project is the thread's project, never a name the sandbox sends; the user must be a member
 *   (`canAccessProject`). A scope is usable only while both switch levels allow it.
 * - Idempotent on (run, tool call): a repeat answers the stored version without a second write.
 * - Audit: `memory.written` (ids, versions, sizes) and refusals as `sandbox.memory_refused`
 *   (reason only); never paths or content.
 */

export type ProjectAccess = (
  tx: KobeTx,
  teamId: string,
  userId: string,
  projectId: string,
) => Promise<boolean>;

export interface MemoryAgentDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  readonly runMaxEvents: number;
  readonly approvals: ApprovalBroker;
  readonly verifier: ApprovalVerifier | undefined;
  readonly log: Logger;
  /** Project membership; default {@link canAccessProject}. */
  readonly projectAccess?: ProjectAccess;
}

export type MemoryReply = MemoryToolsResponse extends infer R
  ? R extends { id: string }
    ? Omit<R, "id">
    : never
  : never;

export type MemoryRefusal =
  | "run_not_active"
  | "not_allowed"
  | "memory_disabled"
  | "no_project"
  | "not_a_member"
  | "approval_denied";

export interface MemoryCaller {
  readonly teamId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
}

export interface PutRequest extends MemoryCaller {
  readonly connectionId: string;
  readonly toolCallId: string;
  readonly input: RememberInput;
  /** Aborts when the connection or run ends (resolves a pending approval as denied). */
  readonly signal: AbortSignal;
  /** Called for each refusal the caller should audit (the module never audits these itself). */
  readonly refused: (reason: MemoryRefusal, scope: MemoryScope) => void;
}

export interface PutOutcome {
  /** The answer for the sandbox. */
  readonly reply: Promise<MemoryReply>;
  /** Settles when all work is over (a project write after `pending_approval` outlives `reply`). */
  readonly done: Promise<void>;
}

const fail = (code: string, message: string): MemoryReply => ({
  ok: false,
  error: { code, message },
});

const NOT_ACTIVE = fail("not_allowed", "The run has ended, so nothing was remembered.");
const NO_PROJECT = fail("not_allowed", "This conversation is not in a project.");
const NOT_MEMBER = fail("not_allowed", "You are not a member of this project.");
const DISABLED = (scope: MemoryScope) =>
  fail("memory_disabled", `${scope === "user" ? "Memory" : "Project memory"} is turned off.`);
const NO_STORAGE = fail("storage_failed", "Memory storage is not available. Try again.");

type Gate =
  | { readonly ok: true; readonly target: MemoryTarget }
  | { readonly ok: false; readonly reason: MemoryRefusal; readonly reply: MemoryReply };

/** Run active and owned by the caller; the thread's project. Undefined: not found or ended. */
async function loadRun(
  tx: KobeTx,
  c: MemoryCaller,
): Promise<{ projectId: string | null } | undefined> {
  const res = await tx.execute<{ status: string; project_id: string | null }>(sql`
    SELECT r.status, t.project_id FROM runs r
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${c.teamId} AND r.id = ${c.runId} AND r.thread_id = ${c.threadId}
       AND t.owner_user_id = ${c.userId}`);
  const row = res.rows[0];
  if (row?.status !== "running" && row?.status !== "waiting_approval") return undefined;
  return { projectId: row.project_id };
}

/** Every check between the sandbox's request and the store, in one transaction's view. */
async function gate(
  tx: KobeTx,
  deps: MemoryAgentDeps,
  c: MemoryCaller,
  scope: MemoryScope,
): Promise<Gate> {
  const run = await loadRun(tx, c);
  if (!run) return { ok: false, reason: "run_not_active", reply: NOT_ACTIVE };
  if (!(await readSwitches(tx, c.teamId)).effective[scope]) {
    return { ok: false, reason: "memory_disabled", reply: DISABLED(scope) };
  }
  if (scope === "user") return { ok: true, target: { scope, ownerUserId: c.userId } };
  if (run.projectId === null) return { ok: false, reason: "no_project", reply: NO_PROJECT };
  const access = deps.projectAccess ?? canAccessProject;
  if (!(await access(tx, c.teamId, c.userId, run.projectId))) {
    return { ok: false, reason: "not_a_member", reply: NOT_MEMBER };
  }
  return { ok: true, target: { scope, projectId: run.projectId } };
}

/** The version this tool call already wrote, if any. */
async function replayOf(tx: KobeTx, c: MemoryCaller, toolCallId: string) {
  const [row] = await tx
    .select({
      scope: memoryDocs.scope,
      path: memoryDocs.path,
      version: memoryDocVersions.version,
    })
    .from(memoryDocVersions)
    .innerJoin(
      memoryDocs,
      and(
        eq(memoryDocs.teamId, memoryDocVersions.teamId),
        eq(memoryDocs.id, memoryDocVersions.docId),
      ),
    )
    .where(
      and(
        eq(memoryDocVersions.teamId, c.teamId),
        eq(memoryDocVersions.runId, c.runId),
        eq(memoryDocVersions.toolCallId, toolCallId),
      ),
    );
  return row;
}

function replyFor(prior: { scope: MemoryScope; path: string; version: number }): MemoryReply {
  return {
    ok: true,
    op: "put",
    status: "applied",
    scope: prior.scope,
    path: prior.path,
    version: prior.version,
    ...(prior.version > 1 ? { previous_version: prior.version - 1 } : {}),
  };
}

async function appendUpdated(
  tx: KobeTx,
  deps: MemoryAgentDeps,
  c: MemoryCaller,
  payload: Record<string, unknown>,
): Promise<void> {
  const run = await tx.execute<{ last_seq: number }>(sql`
    SELECT last_seq FROM runs WHERE team_id = ${c.teamId} AND id = ${c.runId}`);
  // Keep room for the terminal event (as the ingest does); the write stands without its event.
  if ((run.rows[0]?.last_seq ?? deps.runMaxEvents) + 2 > deps.runMaxEvents) {
    deps.log.warn({ run_id: c.runId }, "memory.updated skipped: the run is at its event cap");
    return;
  }
  await appendRunEventsInTx(tx, c.teamId, c.runId, [{ type: "memory.updated", payload }]);
}

type Applied =
  | { readonly kind: "reply"; readonly reply: MemoryReply }
  | { readonly kind: "refused"; readonly reason: MemoryRefusal; readonly reply: MemoryReply };

/** Gate, replay check, write, audit and event: one transaction. */
async function applyInTx(
  deps: MemoryAgentDeps,
  req: PutRequest,
  blobs: BlobStore,
): Promise<Applied> {
  const { input } = req;
  return withAppendTx(deps.db, req.teamId, async (tx): Promise<Applied> => {
    // One writer per tool call, so a duplicate frame can't write twice.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${req.runId}:${req.toolCallId}`}, 0))`,
    );
    const g = await gate(tx, deps, req, input.scope);
    if (!g.ok) return { kind: "refused", reason: g.reason, reply: g.reply };
    const prior = await replayOf(tx, req, req.toolCallId);
    if (prior) return { kind: "reply", reply: replyFor(prior) };
    const written = await writeMemory(
      tx,
      blobs,
      req.teamId,
      g.target,
      {
        path: input.path,
        content: input.content,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      },
      { kind: "agent", userId: req.userId, runId: req.runId, toolCallId: req.toolCallId },
    );
    if (!written.ok) {
      const code = written.code === "version_conflict" ? "storage_failed" : written.code;
      return { kind: "reply", reply: fail(code, written.message) };
    }
    await recordAudit(tx, {
      action: "memory.written",
      actor: { kind: "user", id: req.userId },
      teamId: req.teamId,
      target: {
        scope: input.scope,
        memoryDocId: written.docId,
        version: written.version,
        ...(written.previousVersion === undefined
          ? {}
          : { previousVersion: written.previousVersion }),
        actorKind: "agent",
        sizeBytes: written.sizeBytes,
      },
    });
    await appendUpdated(tx, deps, req, {
      scope: input.scope,
      memory_doc_id: written.docId,
      path: input.path,
      version: written.version,
      ...(written.previousVersion === undefined
        ? {}
        : { previous_version: written.previousVersion }),
      tool_call_id: req.toolCallId,
      mode: input.mode ?? "replace",
    });
    return {
      kind: "reply",
      reply: {
        ok: true,
        op: "put",
        status: "applied",
        scope: input.scope,
        path: input.path,
        version: written.version,
        ...(written.previousVersion === undefined
          ? {}
          : { previous_version: written.previousVersion }),
      },
    };
  });
}

/** Applies a write; storage and run-end failures become replies, never throws. */
async function apply(deps: MemoryAgentDeps, req: PutRequest): Promise<Applied> {
  if (!deps.blobs) return { kind: "reply", reply: NO_STORAGE };
  try {
    return await applyInTx(deps, req, deps.blobs);
  } catch (err) {
    if (err instanceof AppendError && err.code === "run_finished") {
      return { kind: "refused", reason: "run_not_active", reply: NOT_ACTIVE };
    }
    deps.log.error(
      { err, run_id: req.runId, storage: err instanceof MemoryStorageError },
      "memory.put failed",
    );
    return { kind: "reply", reply: NO_STORAGE };
  }
}

function finish(req: PutRequest, applied: Applied): MemoryReply {
  if (applied.kind === "refused") req.refused(applied.reason, req.input.scope);
  return applied.reply;
}

const projectDecision = (): Extract<PolicyDecision, { effect: "require_approval" }> => ({
  effect: "require_approval",
  // The broker sets the real expiry (1 h, D29); this one is only the engine's field.
  expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  risk: "write",
  reasons: [
    {
      code: "risk_write",
      stage: "risk_class",
      message: "remember writes memory shared with the project, which needs your approval.",
    },
  ],
});

/** Whether an approval row exists for this call already (the policy check may have got it). */
async function hasApproval(deps: MemoryAgentDeps, req: PutRequest): Promise<boolean> {
  const row = await withTeam(deps.db, req.teamId, (tx) =>
    loadApprovalForCall(tx, req.teamId, req.runId, req.toolCallId),
  );
  return row !== undefined;
}

async function verified(deps: MemoryAgentDeps, req: PutRequest): Promise<boolean> {
  if (!deps.verifier) return false;
  const check = await deps.verifier.authorize({
    teamId: req.teamId,
    userId: req.userId,
    runId: req.runId,
    toolCallId: req.toolCallId,
    tool: "remember",
    input: req.input,
  });
  return check.ok;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A project write: signed approval first (existing, or asked now), then the write. */
function putProject(deps: MemoryAgentDeps, req: PutRequest): PutOutcome {
  const answer = deferred<MemoryReply>();
  const done = (async () => {
    // Early gate: a non-member or disabled scope never creates an approval card; a repeat of a
    // call that was already applied answers its version.
    const early = await withTeam(deps.db, req.teamId, async (tx) => ({
      gate: await gate(tx, deps, req, "project"),
      prior: await replayOf(tx, req, req.toolCallId),
    }));
    if (!early.gate.ok) {
      req.refused(early.gate.reason, "project");
      answer.resolve(early.gate.reply);
      return;
    }
    if (early.prior) {
      answer.resolve(replyFor(early.prior));
      return;
    }
    if (await hasApproval(deps, req)) {
      // The policy check already asked: apply only if that signed approval covers this input.
      if (await verified(deps, req)) {
        answer.resolve(finish(req, await apply(deps, req)));
      } else {
        req.refused("approval_denied", "project");
        answer.resolve(fail("not_allowed", "This write was not approved."));
      }
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
        tool: "remember",
        input: req.input as unknown as Record<string, unknown>,
        decision: projectDecision(),
        signal: req.signal,
      },
      () =>
        answer.resolve({
          ok: true,
          op: "put",
          status: "pending_approval",
          scope: "project",
          path: req.input.path,
        }),
    );
    if (outcome.decision === "deny" || !(await verified(deps, req))) {
      req.refused("approval_denied", "project");
      answer.resolve(
        fail(
          "not_allowed",
          outcome.decision === "deny" ? outcome.message : "This write was not approved.",
        ),
      );
      return;
    }
    const applied = await apply(deps, req);
    // Only reaches the sandbox when the approval was immediate; otherwise `pending_approval` went first.
    answer.resolve(finish(req, applied));
  })().catch((err: unknown) => {
    deps.log.error({ err, run_id: req.runId }, "project memory write failed");
    answer.resolve(NO_STORAGE);
  });
  return { reply: answer.promise, done };
}

/** `memory.put`: see the module header. Never throws. */
export function putMemory(deps: MemoryAgentDeps, req: PutRequest): PutOutcome {
  if (req.input.scope === "project") return putProject(deps, req);
  const reply = (async () => finish(req, await apply(deps, req)))();
  return { reply, done: reply.then(() => undefined) };
}

// ------------------------------------------------------------------------------------- recall

export interface ReadRequest extends MemoryCaller {
  readonly input: RecallInput;
  readonly refused: (reason: MemoryRefusal, scope?: MemoryScope) => void;
}

/** Most docs a search or listing looks at (the answer holds at most 20 files). */
const SEARCH_DOCS_MAX = 200;
/** Cap on the content one `recall` answer carries. */
const READ_CONTENT_MAX_BYTES = 256 * 1024;

type FileOut = { scope: MemoryScope; path: string; content?: string; version: number };

async function targetsFor(
  tx: KobeTx,
  deps: MemoryAgentDeps,
  req: ReadRequest,
): Promise<{ targets: MemoryTarget[] } | { fail: MemoryReply; reason: MemoryRefusal }> {
  const run = await loadRun(tx, req);
  if (!run) return { fail: NOT_ACTIVE, reason: "run_not_active" };
  const switches = (await readSwitches(tx, req.teamId)).effective;
  const wanted: MemoryScope[] = req.input.scope ? [req.input.scope] : ["user", "project"];
  const targets: MemoryTarget[] = [];
  for (const scope of wanted) {
    if (!switches[scope]) {
      if (req.input.scope) return { fail: DISABLED(scope), reason: "memory_disabled" };
      continue;
    }
    if (scope === "user") {
      targets.push({ scope, ownerUserId: req.userId });
      continue;
    }
    const access = deps.projectAccess ?? canAccessProject;
    if (run.projectId === null || !(await access(tx, req.teamId, req.userId, run.projectId))) {
      if (req.input.scope) {
        return run.projectId === null
          ? { fail: NO_PROJECT, reason: "no_project" }
          : { fail: NOT_MEMBER, reason: "not_a_member" };
      }
      continue;
    }
    targets.push({ scope, projectId: run.projectId });
  }
  return { targets };
}

async function searchFiles(
  tx: KobeTx,
  deps: MemoryAgentDeps,
  blobs: BlobStore,
  req: ReadRequest,
  targets: readonly MemoryTarget[],
): Promise<{ files: FileOut[]; truncated: boolean }> {
  const { path, query } = req.input;
  const docs: DocRow[] = [];
  for (const target of targets) {
    docs.push(...(await listMemory(tx, req.teamId, target)));
  }
  if (path !== undefined) {
    const doc = docs.find((d) => d.path === path);
    const content = doc ? await readCurrent(tx, blobs, req.teamId, doc) : null;
    return doc && content !== null
      ? {
          files: [{ scope: doc.scope, path: doc.path, content, version: doc.currentVersion }],
          truncated: false,
        }
      : { files: [], truncated: false };
  }
  const sorted = [...docs].sort((a, b) =>
    a.path === b.path ? a.scope.localeCompare(b.scope) : a.path.localeCompare(b.path),
  );
  if (query === undefined) {
    return {
      files: sorted
        .slice(0, MEMORY_RECALL_MAX_FILES)
        .map((d) => ({ scope: d.scope, path: d.path, version: d.currentVersion })),
      truncated: sorted.length > MEMORY_RECALL_MAX_FILES,
    };
  }
  const needle = query.toLowerCase();
  const files: FileOut[] = [];
  let bytes = 0;
  let truncated = sorted.length > SEARCH_DOCS_MAX;
  for (const doc of sorted.slice(0, SEARCH_DOCS_MAX)) {
    const content = await readCurrent(tx, blobs, req.teamId, doc);
    if (content === null || !`${doc.path}\n${content}`.toLowerCase().includes(needle)) continue;
    bytes += Buffer.byteLength(content, "utf8");
    if (files.length >= MEMORY_RECALL_MAX_FILES || bytes > READ_CONTENT_MAX_BYTES) {
      truncated = true;
      break;
    }
    files.push({ scope: doc.scope, path: doc.path, content, version: doc.currentVersion });
  }
  return { files, truncated };
}

/** `memory.read`. Never throws. */
export async function readMemory(deps: MemoryAgentDeps, req: ReadRequest): Promise<MemoryReply> {
  if (!deps.blobs) return NO_STORAGE;
  const blobs = deps.blobs;
  try {
    const result = await withTeam(deps.db, req.teamId, async (tx) => {
      const t = await targetsFor(tx, deps, req);
      if ("fail" in t) return t;
      return { found: await searchFiles(tx, deps, blobs, req, t.targets) };
    });
    if ("fail" in result) {
      req.refused(result.reason, req.input.scope);
      return result.fail;
    }
    if (req.input.path !== undefined && result.found.files.length === 0) {
      return fail("not_found", "There is no such memory file.");
    }
    return { ok: true, op: "read", files: result.found.files, truncated: result.found.truncated };
  } catch (err) {
    deps.log.error({ err, run_id: req.runId }, "memory.read failed");
    return NO_STORAGE;
  }
}

// ------------------------------------------------------------------------------ run.start

const indexOf = (content: string) => {
  const lines = content === "" ? [] : content.split("\n");
  return lines.length > MEMORY_INDEX_MAX_LINES
    ? { content: lines.slice(0, MEMORY_INDEX_MAX_LINES).join("\n"), truncated: true }
    : { content, truncated: false };
};

/**
 * `run.start.memory` (KOBE-153): the scopes enabled for this run and each one's `MEMORY.md`
 * (cut to 200 lines, `truncated` says so; empty at version 0 when there is none yet). A disabled
 * scope, or `project` without a project the user belongs to, is absent. Reads under the team's
 * RLS; the caller treats a throw as "no memory context" (the server still enforces every call).
 */
export async function buildRunMemory(
  deps: Pick<MemoryAgentDeps, "db" | "blobs" | "projectAccess">,
  caller: { teamId: string; userId: string; threadId: string },
): Promise<RunMemoryContext> {
  return withTeam(deps.db, caller.teamId, async (tx) => {
    const effective = (await readSwitches(tx, caller.teamId)).effective;
    const targets: MemoryTarget[] = [];
    if (effective.user) targets.push({ scope: "user", ownerUserId: caller.userId });
    if (effective.project) {
      const res = await tx.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM threads
         WHERE team_id = ${caller.teamId} AND id = ${caller.threadId}`);
      const projectId = res.rows[0]?.project_id;
      const access = deps.projectAccess ?? canAccessProject;
      if (projectId && (await access(tx, caller.teamId, caller.userId, projectId))) {
        targets.push({ scope: "project", projectId });
      }
    }
    const indexes: RunMemoryContext["indexes"] = [];
    for (const target of targets) {
      indexes.push({
        scope: target.scope,
        ...(await loadIndex(tx, deps.blobs, caller.teamId, target)),
      });
    }
    return { scopes: targets.map((t) => t.scope), indexes };
  });
}

async function loadIndex(
  tx: KobeTx,
  blobs: BlobStore | undefined,
  teamId: string,
  target: MemoryTarget,
) {
  const docs = await listMemory(tx, teamId, target);
  const doc = docs.find((d) => d.path === MEMORY_INDEX_FILE);
  const raw = doc && blobs ? await readCurrent(tx, blobs, teamId, doc) : null;
  if (!doc || raw === null) return { content: "", version: 0, truncated: false };
  return { ...indexOf(raw), version: doc.currentVersion };
}
