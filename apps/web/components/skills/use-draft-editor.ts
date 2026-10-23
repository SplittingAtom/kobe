"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import { teamDraftClient, type DraftClient } from "../../lib/skills/draft-client";
import type { Changed, DraftFileInfo, DraftSummary } from "../../lib/skills/drafts-api";
import { SKILL_MD } from "../../lib/skills/skill-md";
import { useScanPreview, type ScanState } from "./use-scan-preview";

export type { ScanState } from "./use-scan-preview";

/**
 * The Workbench editor's state (KOBE-321, SK11/SK12). Edits autosave: a file is written once its
 * edits pause for {@link SAVE_IDLE_MS}, and at least every {@link SAVE_MAX_WAIT_MS} while typing
 * goes on. Every change of the draft (autosaves, new and deleted files, sharing) runs in one queue,
 * each naming the revision the one before returned, so the editor never conflicts with its own
 * writes (review S4). After a write the scan preview of the new revision is asked for, so lint
 * (computed on every keystroke) and the scan reflect an edit within 2 s. Leaving the editor (an
 * in-app link, the bar, the palette) writes what is pending (review B2); closing the tab asks
 * first. A stale revision (someone else saved) stops autosave until the draft is reloaded.
 */
export const SAVE_IDLE_MS = 400;
export const SAVE_MAX_WAIT_MS = 1200;

export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";

export interface DraftEditor {
  readonly draft: DraftSummary;
  readonly files: readonly DraftFileInfo[];
  /** Loaded text of the files opened so far (SKILL.md always). */
  readonly texts: Readonly<Record<string, string>>;
  readonly status: SaveStatus;
  readonly error: ApiError | null;
  readonly scan: ScanState;
  /** Changes a text file (autosaved). */
  readonly edit: (path: string, text: string) => void;
  /** Loads a file's text to open it. */
  readonly open: (path: string) => Promise<ApiError | null>;
  /** Adds a text file (empty unless `text` is given), by the same write as an autosave. */
  readonly addFile: (path: string, text?: string) => Promise<ApiError | null>;
  readonly removeFile: (path: string) => Promise<ApiError | null>;
  /** Shares the draft with the team's Builders and Team admins, or stops (author only). */
  readonly share: (shared: boolean) => Promise<ApiError | null>;
  /** Writes every pending edit now; the revision after them, or null when a write failed. */
  readonly flush: () => Promise<number | null>;
}

export type EditorLoad =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly editor: DraftEditor };

interface Loaded {
  readonly draft: DraftSummary;
  readonly files: readonly DraftFileInfo[];
  readonly texts: Readonly<Record<string, string>>;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** A change waits for the edits before it; when one of them failed, it doesn't go ahead. */
const UNSAVED: ApiError = {
  status: 0,
  code: "unsaved_changes",
  message: "An earlier change isn't saved yet. Fix that first.",
};

async function loadDraft(client: DraftClient, id: string): Promise<ApiResult<Loaded>> {
  const res = await client.get(id);
  if (!res.ok) return res;
  const hasSkillMd = res.data.files.some((f) => f.path === SKILL_MD && f.kind === "text");
  const text = hasSkillMd ? await client.readText(id, SKILL_MD) : null;
  if (text && !text.ok) return text;
  const texts: Record<string, string> = text?.ok ? { [SKILL_MD]: text.data } : {};
  return { ok: true, status: 200, data: { draft: res.data.draft, files: res.data.files, texts } };
}

/**
 * `client`: where the draft lives; the active team's Workbench unless given (a Site draft of a
 * catalog skill, KOBE-495). Pass a stable object (memoized).
 */
export function useDraftEditor(teamId: string, id: string, client?: DraftClient): EditorLoad {
  const api = useMemo(() => client ?? teamDraftClient(teamId), [client, teamId]);
  const [load, setLoad] = useState<
    | { readonly status: "loading" }
    | { readonly status: "error"; readonly error: ApiError }
    | { readonly status: "ready"; readonly loaded: Loaded }
  >({ status: "loading" });

  useEffect(() => {
    let current = true;
    void loadDraft(api, id).then((res) => {
      if (!current) return;
      setLoad(
        res.ok ? { status: "ready", loaded: res.data } : { status: "error", error: res.error },
      );
    });
    return () => {
      current = false;
    };
  }, [api, id]);

  const editor = useEditorState(teamId, id, api, load.status === "ready" ? load.loaded : null);
  if (load.status === "error") return load;
  return load.status === "ready" && editor ? { status: "ready", editor } : { status: "loading" };
}

function useEditorState(
  teamId: string,
  id: string,
  api: DraftClient,
  loaded: Loaded | null,
): DraftEditor | null {
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  const [files, setFiles] = useState<readonly DraftFileInfo[]>([]);
  const [texts, setTexts] = useState<Readonly<Record<string, string>>>({});
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<ApiError | null>(null);

  const rev = useRef(0);
  const pending = useRef(new Map<string, string>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  const currentRev = useCallback(() => rev.current, []);
  const scanFn = useCallback(
    (draftId: string, signal: AbortSignal) => api.scan(draftId, signal),
    [api],
  );
  const { scan, rescan } = useScanPreview(teamId, id, currentRev, scanFn);

  /** Runs `op` after every change queued before it. */
  const enqueue = useCallback(<T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(op, op);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const changed = useCallback((res: Changed) => {
    rev.current = res.rev;
    setDraft(res.draft);
  }, []);

  const failed = useCallback((err: ApiError) => {
    setError(err);
    if (err.code === "stale_revision") stopped.current = true;
    setStatus(err.code === "stale_revision" ? "conflict" : "error");
  }, []);

  /** Writes the pending edits (inside the queue); the revision after them, or null. */
  const writePending = useCallback(async (): Promise<number | null> => {
    let wrote = false;
    while (pending.current.size > 0 && !stopped.current) {
      const [path, text] = pending.current.entries().next().value as [string, string];
      pending.current.delete(path);
      setStatus("saving");
      const res = await api.put(id, path, rev.current, text);
      if (!res.ok) {
        if (!pending.current.has(path)) pending.current.set(path, text);
        failed(res.error);
        return null;
      }
      changed(res.data);
      wrote = true;
      setFiles((fs) => fs.map((f) => (f.path === path ? { ...f, size: byteLength(text) } : f)));
    }
    if (stopped.current) return null;
    setError(null);
    setStatus(pending.current.size > 0 ? "pending" : "saved");
    // Only a write makes a new revision to scan (a flush before Save version may write nothing).
    if (wrote) rescan();
    return rev.current;
  }, [api, id, changed, failed, rescan]);

  const flush = useCallback((): Promise<number | null> => {
    for (const t of [idleTimer, maxTimer]) {
      if (t.current) clearTimeout(t.current);
      t.current = null;
    }
    return enqueue(writePending);
  }, [enqueue, writePending]);

  /** A change of the draft, in the queue: the pending edits are written first. */
  const change = useCallback(
    <T>(write: (rev: number) => Promise<ApiResult<T>>, apply: (data: T) => void) => {
      for (const t of [idleTimer, maxTimer]) {
        if (t.current) clearTimeout(t.current);
        t.current = null;
      }
      return enqueue(async (): Promise<ApiError | null> => {
        if ((await writePending()) === null) return UNSAVED;
        const res = await write(rev.current);
        if (!res.ok) {
          if (res.error.code === "stale_revision") failed(res.error);
          return res.error;
        }
        apply(res.data);
        rescan();
        return null;
      });
    },
    [enqueue, writePending, failed, rescan],
  );

  const schedule = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => void flush(), SAVE_IDLE_MS);
    maxTimer.current ??= setTimeout(() => void flush(), SAVE_MAX_WAIT_MS);
  }, [flush]);

  // Adopt a loaded draft once; start its first scan.
  useEffect(() => {
    if (!loaded) return;
    rev.current = loaded.draft.rev;
    setDraft(loaded.draft);
    setFiles(loaded.files);
    setTexts(loaded.texts);
    rescan();
  }, [loaded, rescan]);

  // Closing the tab with unsaved edits asks first; leaving the editor in the app writes them.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      // The queue outlives the page: pending edits are written after it has gone.
      if (pending.current.size > 0) void flushRef.current();
      for (const t of [idleTimer, maxTimer]) if (t.current) clearTimeout(t.current);
    };
  }, []);

  const edit = useCallback(
    (path: string, text: string) => {
      setTexts((t) => ({ ...t, [path]: text }));
      if (stopped.current) return;
      pending.current.set(path, text);
      setStatus("pending");
      schedule();
    },
    [schedule],
  );

  const open = useCallback(
    async (path: string) => {
      if (texts[path] !== undefined) return null;
      const res = await api.readText(id, path);
      if (!res.ok) return res.error;
      setTexts((t) => (t[path] === undefined ? { ...t, [path]: res.data } : t));
      return null;
    },
    [api, id, texts],
  );

  const addFile = useCallback(
    (path: string, text = "") =>
      change(
        (r) => api.put(id, path, r, text),
        (data) => {
          changed(data);
          const info: DraftFileInfo = {
            path,
            size: byteLength(text),
            kind: "text",
            updatedAt: data.draft.updatedAt,
          };
          setFiles((fs) => [...fs, info].sort((a, b) => a.path.localeCompare(b.path)));
          setTexts((t) => ({ ...t, [path]: text }));
        },
      ),
    [api, id, change, changed],
  );

  const removeFile = useCallback(
    (path: string) => {
      pending.current.delete(path);
      return change(
        (r) => api.remove(id, path, r),
        (data) => {
          changed(data);
          setFiles((fs) => fs.filter((f) => f.path !== path));
          setTexts((t) => Object.fromEntries(Object.entries(t).filter(([p]) => p !== path)));
        },
      );
    },
    [api, id, change, changed],
  );

  const share = useCallback(
    (shared: boolean) =>
      change(
        (r) => api.share(id, r, shared),
        (next) => {
          rev.current = next.rev;
          setDraft(next);
        },
      ),
    [api, id, change],
  );

  if (!draft) return null;
  return {
    draft,
    files,
    texts,
    status,
    error,
    scan,
    edit,
    open,
    addFile,
    removeFile,
    share,
    flush,
  };
}
