import { createHash } from "node:crypto";
import { canonicalZip, SkillPackageError } from "@kobe/protocol";
import { and, eq, skillDrafts, withTeam } from "@kobe/db";
import { findThread } from "../../threads/repository.js";
import { viewerProjectIds } from "../../threads/references.js";
import { liveFilesUnder } from "../../workspace-files/browse.js";
import { currentEntry } from "../../workspace-sync/store.js";
import type { WorkspaceSync } from "../../workspace-sync/index.js";
import { validateZipBundle, type BundleError } from "../bundle.js";
import { SKILL_LIMITS } from "../limits.js";
import { DRAFT_LIMITS } from "./files.js";
import { packageFiles } from "./starts.js";
import { createDraft, replaceDraftFiles, type DraftContext, type DraftOutcome } from "./service.js";
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
  | (DraftOutcome<{ draft: DraftRecord }> & { readonly created?: boolean })
  | { readonly ok: false; readonly error: "thread_not_found" | "folder_empty" | "folder_changed" }
  | { readonly ok: false; readonly error: "invalid_bundle"; readonly bundle: BundleError };

/** The draft's zip is stored, not deflated: its 5 MiB of files plus headers (as Save version). */
const DRAFT_BUNDLE_LIMITS = {
  ...SKILL_LIMITS,
  maxBundleBytes: DRAFT_LIMITS.maxDraftBytes + DRAFT_LIMITS.maxFiles * 1024,
};

async function readFolder(
  ctx: DraftContext,
  sync: WorkspaceSync,
  folder: string,
): Promise<Map<string, Uint8Array> | Exclude<WorkspaceSaveResult, { ok: true }>> {
  const owner = { teamId: ctx.teamId, userId: ctx.viewer.userId };
  const base = `skills/${folder}`;
  const entries = await withTeam(ctx.db, ctx.teamId, async (tx) => {
    const listed = await liveFilesUnder(tx, owner, base, DRAFT_LIMITS.maxFiles + 1);
    if (listed.length > DRAFT_LIMITS.maxFiles) return "too_many" as const;
    if (listed.reduce((n, f) => n + f.size, 0) > DRAFT_LIMITS.maxDraftBytes)
      return "too_large" as const;
    const out = [];
    for (const f of listed) {
      const entry = await currentEntry(tx, owner, f.path);
      if (entry && !entry.deleted && entry.blobKey) out.push({ path: f.path, entry });
    }
    return out;
  });
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
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    // Content-addressed: bytes that don't match the manifest's hash are not the synced file.
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`workspace object for ${path} does not match its hash`);
    files.set(path.slice(base.length + 1), new Uint8Array(bytes));
  }
  return files;
}

/** The caller's draft started from this conversation under `name`, if there is one. */
async function existingDraft(ctx: DraftContext, threadId: string, name: string) {
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
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
}

export async function saveWorkspaceSkill(
  ctx: DraftContext,
  sync: WorkspaceSync,
  input: { readonly threadId: string; readonly folder: string },
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
  const read = await readFolder(ctx, sync, input.folder);
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
  const files = packageFiles(valid.value);
  const existing = await existingDraft(ctx, input.threadId, valid.value.name);
  if (existing) return { ...(await replaceDraftFiles(ctx, existing, files)), created: false };
  const made = await createDraft(ctx, {
    name: valid.value.name,
    startedFrom: "thread",
    fromThreadId: input.threadId,
    files,
  });
  return { ...made, created: true };
}
