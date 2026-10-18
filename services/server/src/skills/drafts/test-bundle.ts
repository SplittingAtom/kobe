import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { SkillBundleRef } from "@kobe/protocol";
import { canonicalZip, SkillPackageError } from "@kobe/protocol";
import {
  and,
  eq,
  inArray,
  skillDrafts,
  teamMembers,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import type { ScanResult } from "@kobe/skill-scanner";
import type { BlobStore } from "../../retention/blobs.js";
import type { SkillRef } from "../../resolver/resolve.js";
import { isBlocked } from "../blocklist.js";
import { validateZipBundle } from "../bundle.js";
import { SKILL_LIMITS } from "../limits.js";
import { scanCanonicalZip } from "../review.js";
import { ScanBusyError } from "../scan-pool.js";
import { DRAFT_LIMITS, SKILL_MD_PATH } from "./files.js";
import { readAllFiles, visibleDraft, type DraftRecord } from "./records.js";

/**
 * A draft's test bundle (KOBE-323, SK13): the runtime zip of the draft's current revision, what a
 * Workbench test chat's run loads, and nothing else. Drafts are not scanned while edited, so the
 * bundle is scanned in full (the save's scan: same pool, rules and verdict) before it can reach a
 * sandbox, and it is stored only when the scan did not Block:
 *
 *   <prefix>skills/drafts/<team_id>/<draft_id>/<sha256>
 *
 * So an object at that key means "these exact bytes scanned without a Block". The run start
 * (resolver, in its transaction) rebuilds the zip from the draft's files, and lists it only if that
 * object exists: a draft edited after the send is "changed, send again", never an unscanned load.
 * The objects go with the draft (delete and purge, `deleteDraftBundles`); nothing else refers to
 * them (no row holds the key, so no legal-hold history can).
 */

const DRAFT_BUNDLE_LIMITS = {
  ...SKILL_LIMITS,
  maxBundleBytes: DRAFT_LIMITS.maxDraftBytes + DRAFT_LIMITS.maxFiles * 1024,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The folder of a draft's test bundles. */
export function draftBundlePrefix(prefix: string, teamId: string, draftId: string): string {
  if (!UUID.test(teamId) || !UUID.test(draftId))
    throw new Error("draft bundle keys: team and draft must be UUIDs");
  return `${prefix}skills/drafts/${teamId}/${draftId}/`;
}

export function draftBundleKey(
  prefix: string,
  teamId: string,
  draftId: string,
  sha256: string,
): string {
  if (!SHA256.test(sha256)) throw new Error("draft bundle keys: the hash must be a SHA-256");
  return `${draftBundlePrefix(prefix, teamId, draftId)}${sha256}`;
}

export interface DraftRuntime {
  readonly name: string;
  /** The runtime zip (what a sandbox unpacks) and its SHA-256. */
  readonly zip: Uint8Array;
  readonly sha256: string;
  /** What the save would scan: the package zip, or the runtime zip when they are the same. */
  readonly scanZip: Uint8Array;
}

/** The draft's files as a runtime bundle, through the upload's validation; or why not. */
export async function draftRuntime(
  tx: KobeTx,
  teamId: string,
  draftId: string,
): Promise<{ ok: true; value: DraftRuntime } | { ok: false; message: string }> {
  const files = await readAllFiles(tx, teamId, draftId);
  if (!files.has(SKILL_MD_PATH))
    return {
      ok: false,
      message: "The draft needs a SKILL.md at its root before it can be tested.",
    };
  let zip: Uint8Array;
  try {
    zip = canonicalZip(files);
  } catch (err) {
    if (!(err instanceof SkillPackageError)) throw err;
    return { ok: false, message: err.message };
  }
  const valid = validateZipBundle(zip, DRAFT_BUNDLE_LIMITS);
  if (!valid.ok) return { ok: false, message: valid.error.message };
  const runtime = valid.value.zip;
  return {
    ok: true,
    value: {
      name: valid.value.name,
      zip: runtime,
      sha256: createHash("sha256").update(runtime).digest("hex"),
      scanZip: valid.value.packageZip ?? runtime,
    },
  };
}

/** Whether the scanned bundle object exists (the body is not read). */
export async function hasDraftBundle(blobs: BlobStore, key: string): Promise<boolean> {
  const object = await blobs.objects.get(key);
  if (!object) return false;
  object.body.destroy();
  return true;
}

/** The thread owner's role in the team, or null once they left it. */
export async function memberRole(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<TeamRole | null> {
  const [row] = await tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return row?.role ?? null;
}

export type PrepareResult =
  | { readonly ok: true; readonly sha256: string }
  | {
      readonly ok: false;
      readonly error:
        | "draft_unavailable"
        | "invalid_draft"
        | "blocklisted"
        | "scan_blocked"
        | "scan_incomplete"
        | "scan_busy";
      readonly message: string;
    };

const INCOMPLETE = new Set(["scan-incomplete", "scan-resources-exceeded"]);

/** The Block findings, as one line the member can act on. */
function blockMessage(scan: ScanResult): string {
  const rules = [
    ...new Set(scan.findings.filter((f) => f.severity === "block").map((f) => f.rule)),
  ];
  const named = rules.length > 0 ? ` (${rules.slice(0, 5).join(", ")})` : "";
  return `The scan blocks this draft${named}, so it can't be tested. Fix the findings in the editor and send again.`;
}

export const UNAVAILABLE_MESSAGE =
  "This test chat's draft isn't available: it was deleted, or it is no longer shared with you.";

/**
 * Before a test chat's message is accepted (outside any run transaction: a scan takes seconds):
 * the draft's current revision is built, checked against the blocklist and scanned in full, and
 * stored under its hash unless the scan Blocks. A bundle already stored is not scanned again.
 */
export async function prepareDraftTest(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore },
  who: { readonly teamId: string; readonly userId: string; readonly role: TeamRole },
  draftId: string,
): Promise<PrepareResult> {
  const built = await withTeam(deps.db, who.teamId, async (tx) => {
    const draft: DraftRecord | null = await visibleDraft(tx, who.teamId, draftId, who);
    if (!draft) return null;
    const runtime = await draftRuntime(tx, who.teamId, draftId);
    if (!runtime.ok) return runtime;
    return { ...runtime, blocked: await isBlocked(tx, runtime.value.sha256) };
  });
  if (!built) return { ok: false, error: "draft_unavailable", message: UNAVAILABLE_MESSAGE };
  if (!built.ok) return { ok: false, error: "invalid_draft", message: built.message };
  const { value } = built;
  if (built.blocked)
    return {
      ok: false,
      error: "blocklisted",
      message: "This draft's files are on the site's blocklist, so it can't be tested.",
    };
  const key = draftBundleKey(deps.blobs.prefix, who.teamId, draftId, value.sha256);
  if (await hasDraftBundle(deps.blobs, key)) return { ok: true, sha256: value.sha256 };
  let scan: ScanResult;
  try {
    scan = await scanCanonicalZip(value.scanZip, { owner: who.userId });
  } catch (err) {
    if (!(err instanceof ScanBusyError)) throw err;
    return {
      ok: false,
      error: "scan_busy",
      message: "Skill scans are busy right now. Send again in a few seconds.",
    };
  }
  if (scan.findings.some((f) => INCOMPLETE.has(f.rule)))
    return {
      ok: false,
      error: "scan_incomplete",
      message:
        "The draft's scan couldn't finish. Send again; if it keeps failing, make it smaller.",
    };
  if (scan.verdict === "block")
    return { ok: false, error: "scan_blocked", message: blockMessage(scan) };
  await deps.blobs.objects.put(key, Readable.from([Buffer.from(value.zip)]), value.zip.length);
  return { ok: true, sha256: value.sha256 };
}

export type DraftSkillResult =
  | { readonly ok: true; readonly ref: SkillRef; readonly bundle: SkillBundleRef }
  | {
      readonly ok: false;
      readonly code: "skill_draft_unavailable" | "skill_draft_changed";
    };

/**
 * At run start, in the run's transaction: the draft a test chat runs, as the run's only skill.
 * The draft must still be one its owner may see, its current files must form a bundle that is
 * not blocklisted now, and that exact bundle must have been scanned and stored.
 */
export async function draftSkillForRun(
  tx: KobeTx,
  blobs: BlobStore | undefined,
  input: { readonly teamId: string; readonly ownerUserId: string; readonly draftId: string | null },
): Promise<DraftSkillResult> {
  if (input.draftId === null || !blobs) return { ok: false, code: "skill_draft_unavailable" };
  const role = await memberRole(tx, input.teamId, input.ownerUserId);
  const viewer = role === null ? null : { userId: input.ownerUserId, role };
  const draft = viewer ? await visibleDraft(tx, input.teamId, input.draftId, viewer) : null;
  if (!draft) return { ok: false, code: "skill_draft_unavailable" };
  const runtime = await draftRuntime(tx, input.teamId, input.draftId);
  if (!runtime.ok || (await isBlocked(tx, runtime.value.sha256)))
    return { ok: false, code: "skill_draft_changed" };
  const { name, sha256, zip } = runtime.value;
  const key = draftBundleKey(blobs.prefix, input.teamId, input.draftId, sha256);
  if (!(await hasDraftBundle(blobs, key))) return { ok: false, code: "skill_draft_changed" };
  return {
    ok: true,
    ref: { name, hash: sha256, source: "draft" },
    bundle: { name, sha256, size: zip.length },
  };
}

/** Removes every stored test bundle of a draft (its delete and purge). */
export async function deleteDraftBundles(
  blobs: BlobStore,
  teamId: string,
  draftId: string,
): Promise<void> {
  const prefix = draftBundlePrefix(blobs.prefix, teamId, draftId);
  let after: string | undefined;
  for (;;) {
    const page = await blobs.objects.list(prefix, after === undefined ? {} : { cursor: after });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) await blobs.objects.delete(keys);
    if (!page.next) return;
    after = page.next;
  }
}

/**
 * The team's test bundles whose draft is gone (deleted by its author, the retention purge or the
 * departed-author sweep; or stored by a send that raced the delete): removed, folder by folder.
 * The retention job runs it per team, so a failed delete never leaves bundles behind for good.
 */
export async function sweepOrphanDraftBundles(
  db: KobeDb,
  blobs: BlobStore,
  teamId: string,
): Promise<{ readonly drafts: number }> {
  const root = `${blobs.prefix}skills/drafts/${teamId}/`;
  if (!UUID.test(teamId)) return { drafts: 0 };
  let cursor: string | undefined;
  let removed = 0;
  for (;;) {
    const page = await blobs.objects.list(root, {
      delimiter: "/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const ids = page.prefixes
      .map((p) => p.slice(root.length).replace(/\/$/, ""))
      .filter((id) => UUID.test(id));
    if (ids.length > 0) {
      const live = await withTeam(db, teamId, (tx) =>
        tx
          .select({ id: skillDrafts.id })
          .from(skillDrafts)
          .where(and(eq(skillDrafts.teamId, teamId), inArray(skillDrafts.id, ids))),
      );
      const kept = new Set(live.map((r) => r.id));
      for (const id of ids.filter((d) => !kept.has(d))) {
        await deleteDraftBundles(blobs, teamId, id);
        removed += 1;
      }
    }
    if (!page.next) return { drafts: removed };
    cursor = page.next;
  }
}
