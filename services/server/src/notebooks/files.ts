import { withTeam, type KobeDb } from "@kobe/db";
import { NOTEBOOK_FILE_MAX_BYTES, UPLOAD_DEFAULT_MAX_FILE_BYTES } from "@kobe/protocol";
import { runWithAuditContext } from "../audit/context.js";
import { isInternalPath } from "../workspace-files/paths.js";
import { saveWorkspaceFile, type SaveResult } from "../workspace-files/save.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { currentEntry } from "../workspace-sync/store.js";

/**
 * The notebooks' view of the member's synced workspace (docs/specs/notebooks.md NB11): read a
 * notebook or `.py` file as text with its version, and save a notebook at the version it was
 * read through the file editor's save path (FE4). `index.ts` binds the workspace store later
 * (`use`); without one every read is `unavailable`.
 */
export type NotebookRead =
  | { readonly ok: true; readonly sha256: string; readonly text: string }
  | { readonly ok: false; readonly code: "not_found" | "too_large" | "unavailable" };

export interface NotebookFiles {
  use(sync: WorkspaceSync): void;
  read(owner: WorkspaceOwner, path: string): Promise<NotebookRead>;
  save(owner: WorkspaceOwner, path: string, baseSha256: string, text: string): Promise<SaveResult>;
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

export function createNotebookFiles(
  db: KobeDb,
  options: { readonly teamQuotaDefaultBytes: number },
): NotebookFiles {
  let sync: WorkspaceSync | undefined;
  const limitBytes = () =>
    Math.min(
      NOTEBOOK_FILE_MAX_BYTES,
      UPLOAD_DEFAULT_MAX_FILE_BYTES,
      sync?.limits.maxFileBytes ?? NOTEBOOK_FILE_MAX_BYTES,
    );
  return {
    use(store) {
      sync = store;
    },
    async read(owner, path) {
      const store = sync;
      if (store === undefined) return { ok: false, code: "unavailable" };
      if (isInternalPath(path)) return { ok: false, code: "not_found" };
      const entry = await withTeam(db, owner.teamId, (tx) => currentEntry(tx, owner, path));
      if (!entry || entry.deleted || entry.blobKey === null || entry.sha256 === undefined) {
        return { ok: false, code: "not_found" };
      }
      if (entry.size > limitBytes()) return { ok: false, code: "too_large" };
      const object = await store.objects.get(entry.blobKey);
      if (!object) return { ok: false, code: "not_found" };
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of object.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buf.length;
        if (size > limitBytes()) {
          object.body.destroy();
          return { ok: false, code: "too_large" };
        }
        chunks.push(buf);
      }
      try {
        return { ok: true, sha256: entry.sha256, text: DECODER.decode(Buffer.concat(chunks)) };
      } catch {
        return { ok: false, code: "not_found" };
      }
    },
    save(owner, path, baseSha256, text) {
      const store = sync;
      if (store === undefined) {
        return Promise.resolve({
          ok: false,
          status: 503,
          code: "sandbox_unavailable",
          message: "Workspace files are not available here.",
        });
      }
      // The save is the member's own (their execution's outputs, into their notebook): the audit
      // event `workspace.file_saved` names them, also when the agent's run_python caused it.
      return runWithAuditContext(
        { actor: { kind: "user", id: owner.userId }, ip: null, userAgent: null },
        () =>
          saveWorkspaceFile(db, store, owner, {
            path,
            baseSha256,
            content: Buffer.from(text, "utf8"),
            limitBytes: limitBytes(),
            teamQuotaDefaultBytes: options.teamQuotaDefaultBytes,
          }),
      );
    },
  };
}
