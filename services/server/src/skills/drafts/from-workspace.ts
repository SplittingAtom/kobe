import { createHash } from "node:crypto";
import { canonicalZip, SkillPackageError } from "@kobe/protocol";
import { and, eq, isNotNull, skillDrafts, withTeam, type KobeTx } from "@kobe/db";
import { findThread } from "../../threads/repository.js";
import { viewerProjectIds } from "../../threads/references.js";
import { liveFilesUnder } from "../../workspace-files/browse.js";
import { currentEntry } from "../../workspace-sync/store.js";
import type { WorkspaceSync } from "../../workspace-sync/index.js";
import { validateZipBundle, type BundleError } from "../bundle.js";
import { SKILL_LIMITS } from "../limits.js";
import { DRAFT_LIMITS } from "./files.js";
import { packageFiles } from "./starts.js";
import {
  createDraft,
  isSyncNameClash,
  replaceDraftFiles,
  type DraftContext,
  type DraftOutcome,
  type DraftStartInput,
  type ToolCallRef,
} from "./service.js";
import type { DraftRecord } from "./records.js";

/**
 * Save to Workbench (KOBE-322, spec SK10 start 2): the folder `/workspace/skills/<folder>/` of the
 * caller's workspace in this team (what `skill-creator` builds in a conversation) becomes a draft,
 * through the upload's own validation. The draft records the conversation it came from
 * (`from_thread_id`, a thread of this team the caller can read), so saving it as a personal skill
 * asks first (SK11). Saving again from the same conversation updates that draft.
 *
 * Only what the workspace sync has stored is read (the sandbox pushes its files after each run);
 * the file count and sizes are checked from the manifest before any bytes are fetched.
 */

export type WorkspaceSaveResult =
  | (DraftOutcome<{ draft: DraftRecord }> & {
      readonly created?: boolean;
      /** A new draft although the conversation had one: it was shared or edited (KOBE-442 M2). */
      readonly newBecause?: "shared" | "edited";
    })
  | { readonly ok: false; readonly error: "name_mismatch"; readonly name: string }
  | {
      readonly ok: false;
      readonly error: "thread_not_found" | "folder_empty" | "folder_changed" | "outside_folder";
    }
  | { readonly ok: false; readonly error: "invalid_bundle"; readonly bundle: BundleError };

/** A file as the sandbox pushed it (`save_skill_draft`, KOBE-442): its live row must match. */
export interface PinnedFile {
  readonly path: string;
  readonly rev: number;
  readonly sha256: string;
  readonly size: number;
}

export interface WorkspaceSaveInput {
  readonly threadId: string;
  readonly folder: string;
  /**
   * `save_skill_draft`: exactly these pushed files, each unchanged since its push (else
   * `folder_changed`); absent (Save to Workbench): every live file under the folder.
   */
  readonly pinned?: readonly PinnedFile[];
  readonly via?: "tool";
  /** The agent's call, for the audit events (review L3). */
  readonly toolCall?: ToolCallRef;
}

type Owner = { readonly teamId: string; readonly userId: string };
type ListedEntry = { path: string; entry: NonNullable<Awaited<ReturnType<typeof currentEntry>>> };
type Listing = ListedEntry[] | "too_many" | "too_large" | "outside" | "changed";

/** Every live file under `base`, counted and sized from the manifest before any bytes. */
async function liveEntries(tx: KobeTx, owner: Owner, base: string): Promise<Listing> {
  const listed = await liveFilesUnder(tx, owner, base, DRAFT_LIMITS.maxFiles + 1);
  if (listed.length > DRAFT_LIMITS.maxFiles) return "too_many";
  if (listed.reduce((n, f) => n + f.size, 0) > DRAFT_LIMITS.maxDraftBytes) return "too_large";
  const out: ListedEntry[] = [];
  for (const f of listed) {
    const entry = await currentEntry(tx, owner, f.path);
    if (entry && !entry.deleted && entry.blobKey) out.push({ path: f.path, entry });
  }
  return out;
}

/** The pushed files, each under `base` and with its live row exactly as pushed. */
async function pinnedEntries(
  tx: KobeTx,
  owner: Owner,
  base: string,
  pinned: readonly PinnedFile[],
): Promise<Listing> {
  if (pinned.some((f) => !f.path.startsWith(`${base}/`))) return "outside";
  if (pinned.length > DRAFT_LIMITS.maxFiles) return "too_many";
  if (pinned.reduce((n, f) => n + f.size, 0) > DRAFT_LIMITS.maxDraftBytes) return "too_large";
  const out: ListedEntry[] = [];
  for (const f of pinned) {
    const entry = await currentEntry(tx, owner, f.path);
    if (
      !entry ||
      entry.deleted ||
      !entry.blobKey ||
      entry.rev !== f.rev ||
      entry.sha256 !== f.sha256 ||
      entry.size !== f.size
    )
      return "changed";
    out.push({ path: f.path, entry });
  }
  return out;
}

/** The draft's zip is stored, not deflated: its 5 MiB of files plus headers (as Save version). */
const DRAFT_BUNDLE_LIMITS = {
  ...SKILL_LIMITS,
  maxBundleBytes: DRAFT_LIMITS.maxDraftBytes + DRAFT_LIMITS.maxFiles * 1024,
};

async function readFolder(
  ctx: DraftContext,
  sync: WorkspaceSync,
  folder: string,
  pinned: readonly PinnedFile[] | undefined,
): Promise<Map<string, Uint8Array> | Exclude<WorkspaceSaveResult, { ok: true }>> {
  const owner = { teamId: ctx.teamId, userId: ctx.viewer.userId };
  const base = `skills/${folder}`;
  const entries = await withTeam(ctx.db, ctx.teamId, (tx) =>
    pinned ? pinnedEntries(tx, owner, base, pinned) : liveEntries(tx, owner, base),
  );
  if (entries === "outside") return { ok: false, error: "outside_folder" };
  if (entries === "changed") return { ok: false, error: "folder_changed" };
  if (entries === "too_many") return { ok: false, error: "too_many_files" };
  if (entries === "too_large")
    return {
      ok: false,
      error: "draft_too_large",
      message: `A draft may hold at most ${DRAFT_LIMITS.maxDraftBytes} bytes in all.`,
    };
  if (entries.length === 0) return { ok: false, error: "folder_empty" };
  const files = new Map<string, Uint8Array>();
  for (const { path, entry } of entries) {
    const object = await sync.objects.get(entry.blobKey as string);
    // Collected since the listing (the file changed meanwhile): the caller saves again.
    if (!object) return { ok: false, error: "folder_changed" };
    const bytes = await readCapped(object.body, entry.size);
    // Content-addressed: bytes that don't match the manifest's hash are not the synced file.
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(
        `workspace object ${entry.blobKey} for ${path} does not match its size or hash`,
      );
    files.set(path.slice(base.length + 1), new Uint8Array(bytes));
  }
  return files;
}

/** An object's bytes, or null once it holds more than the manifest's size (review N1). */
async function readCapped(body: AsyncIterable<unknown>, size: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > size) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** The caller's draft this conversation saves `name` into, if there is one. */
async function syncTarget(ctx: DraftContext, threadId: string, name: string) {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const [row] = await tx
      .select({ id: skillDrafts.id })
      .from(skillDrafts)
      .where(
        and(
          eq(skillDrafts.teamId, ctx.teamId),
          eq(skillDrafts.ownerUserId, ctx.viewer.userId),
          eq(skillDrafts.fromThreadId, threadId),
          eq(skillDrafts.name, name),
          isNotNull(skillDrafts.syncedRev),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
}

/** A new draft from the conversation; "clash" when a concurrent save made the target first. */
async function tryCreate(ctx: DraftContext, start: DraftStartInput) {
  try {
    return await createDraft(ctx, start);
  } catch (err) {
    if (isSyncNameClash(err)) return "clash" as const;
    throw err;
  }
}

/** How often a save looks for the target again after losing a race to a concurrent one. */
const SAVE_ATTEMPTS = 3;

/**
 * Writes `files` into the conversation's draft of `name`, or makes it (KOBE-322, KOBE-442). The
 * unique save target per (author, conversation, name) makes concurrent saves meet on one draft:
 * the loser of a create looks again and updates the winner. The agent's tool updates only a
 * private draft nobody changed since its last save; otherwise it makes a new private draft (the
 * old one keeps its files and is no longer saved into) and says why.
 */
async function writeTarget(
  ctx: DraftContext,
  input: WorkspaceSaveInput,
  name: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<WorkspaceSaveResult> {
  const tool = input.via
    ? { via: input.via, ...(input.toolCall ? { toolCall: input.toolCall } : {}) }
    : {};
  const start = {
    name,
    startedFrom: "thread" as const,
    fromThreadId: input.threadId,
    files,
    ...tool,
  };
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const target = await syncTarget(ctx, input.threadId, name);
    if (target) {
      const replaced = await replaceDraftFiles(ctx, target, files, {
        fromThreadId: input.threadId,
        ...tool,
      });
      if (replaced.ok || replaced.error !== "not_sync_target")
        return { ...replaced, created: false };
      const made = await tryCreate(ctx, { ...start, detach: target });
      if (made === "clash") continue;
      return { ...made, created: true, newBecause: replaced.because };
    }
    const made = await tryCreate(ctx, start);
    if (made !== "clash") return { ...made, created: true };
  }
  return { ok: false, error: "folder_changed" };
}

export async function saveWorkspaceSkill(
  ctx: DraftContext,
  sync: WorkspaceSync,
  input: WorkspaceSaveInput,
): Promise<WorkspaceSaveResult> {
  // A conversation of this team the caller can read (RLS and the viewer's access, as threads).
  const thread = await withTeam(ctx.db, ctx.teamId, async (tx) => {
    const viewer = {
      teamId: ctx.teamId,
      userId: ctx.viewer.userId,
      projectIds: await viewerProjectIds(tx, ctx.teamId, ctx.viewer.userId),
    };
    return findThread(tx, viewer, input.threadId);
  });
  if (!thread) return { ok: false, error: "thread_not_found" };
  const read = await readFolder(ctx, sync, input.folder, input.pinned);
  if (!(read instanceof Map)) return read;
  let zip: Uint8Array;
  try {
    zip = canonicalZip(read);
  } catch (err) {
    if (!(err instanceof SkillPackageError)) throw err;
    return {
      ok: false,
      error: "invalid_bundle",
      bundle: { code: "unsafe_path", message: err.message },
    };
  }
  const valid = validateZipBundle(zip, DRAFT_BUNDLE_LIMITS);
  if (!valid.ok) return { ok: false, error: "invalid_bundle", bundle: valid.error };
  // The tool's policy decision saw the folder: the skill must be named after it (review L1).
  if (input.via === "tool" && valid.value.name !== input.folder)
    return { ok: false, error: "name_mismatch", name: valid.value.name };
  return writeTarget(ctx, input, valid.value.name, packageFiles(valid.value));
}
