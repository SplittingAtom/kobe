"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import {
  deleteDraftFile,
  getDraft,
  putDraftFile,
  readDraftText,
  scanDraft,
  type Changed,
  type DraftFileInfo,
  type DraftSummary,
  type ScanPreview,
} from "../../lib/skills/drafts-api";
import { SKILL_MD } from "../../lib/skills/skill-md";

/**
 * The Workbench editor's state (KOBE-321, SK11/SK12). Edits autosave: a file is written once its
 * edits pause for {@link SAVE_IDLE_MS}, and at least every {@link SAVE_MAX_WAIT_MS} while typing
 * goes on; writes run one at a time, each naming the revision the last one returned. After the
 * writes the scan preview of that revision is fetched, so lint (computed on every keystroke) and
 * the scan reflect an edit within 2 s. A stale revision (someone else saved) stops autosave until
 * the draft is reloaded.
 */
export const SAVE_IDLE_MS = 400;
export const SAVE_MAX_WAIT_MS = 1200;
/** After a busy scan preview, try again this much later (the server's Retry-After). */
export const SCAN_RETRY_MS = 10_000;

export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";

export type ScanState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly last: ScanPreview | null }
  | { readonly status: "ready"; readonly scan: ScanPreview }
  | {
      readonly status: "busy" | "error";
      readonly last: ScanPreview | null;
      readonly message: string;
    };

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
  /** Adds an empty text file. */
  readonly addFile: (path: string) => Promise<ApiError | null>;
  readonly removeFile: (path: string) => Promise<ApiError | null>;
  /** Writes every pending edit now; the revision after them, or null when a write failed. */
  readonly flush: () => Promise<number | null>;
  /** The draft after a change made elsewhere (sharing): its new revision. */
  readonly replaceDraft: (draft: DraftSummary) => void;
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

/** A file change waits for earlier edits; when one of them failed, it doesn't go ahead. */
const UNSAVED: ApiError = {
  status: 0,
  code: "unsaved_changes",
  message: "An earlier change isn't saved yet. Fix that first.",
};

async function loadDraft(teamId: string, id: string) {
  const res = await getDraft(teamId, id);
  if (!res.ok) return res;
  const hasSkillMd = res.data.files.some((f) => f.path === SKILL_MD && f.kind === "text");
  const text = hasSkillMd ? await readDraftText(teamId, id, SKILL_MD) : null;
  if (text && !text.ok) return text;
  const texts: Record<string, string> = text?.ok ? { [SKILL_MD]: text.data } : {};
  return { ok: true as const, data: { draft: res.data.draft, files: res.data.files, texts } };
}

export function useDraftEditor(teamId: string, id: string): EditorLoad {
  const [load, setLoad] = useState<
    | { readonly status: "loading" }
    | { readonly status: "error"; readonly error: ApiError }
    | { readonly status: "ready"; readonly loaded: Loaded }
  >({ status: "loading" });

  useEffect(() => {
    let current = true;
    void loadDraft(teamId, id).then((res) => {
      if (!current) return;
      setLoad(
        res.ok ? { status: "ready", loaded: res.data } : { status: "error", error: res.error },
      );
    });
    return () => {
      current = false;
    };
  }, [teamId, id]);

  const editor = useEditorState(teamId, id, load.status === "ready" ? load.loaded : null);
  if (load.status !== "ready" || !editor)
    return load.status === "error" ? load : { status: "loading" };
  return { status: "ready", editor };
}

function useEditorState(teamId: string, id: string, loaded: Loaded | null): DraftEditor | null {
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  const [files, setFiles] = useState<readonly DraftFileInfo[]>([]);
  const [texts, setTexts] = useState<Readonly<Record<string, string>>>({});
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<ApiError | null>(null);
  const [scan, setScan] = useState<ScanState>({ status: "idle" });

  const rev = useRef(0);
  const pending = useRef(new Map<string, string>());
  const chain = useRef<Promise<number | null>>(Promise.resolve(0));
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanAbort = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const lastScan = useRef<ScanPreview | null>(null);

  const changed = useCallback((res: Changed) => {
    rev.current = res.rev;
    setDraft(res.draft);
  }, []);

  const runScan = useCallback(async () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    scanAbort.current?.abort();
    const abort = new AbortController();
    scanAbort.current = abort;
    setScan({ status: "running", last: lastScan.current });
    const res = await scanDraft(teamId, id, abort.signal);
    if (abort.signal.aborted) return;
    if (res.ok) {
      // A scan of an older revision than the editor's is superseded by the next one.
      if (res.data.rev < rev.current) return;
      lastScan.current = res.data;
      setScan({ status: "ready", scan: res.data });
      return;
    }
    if (res.error.code === "scan_busy") {
      retryTimer.current = setTimeout(() => void runScan(), SCAN_RETRY_MS);
      setScan({ status: "busy", last: lastScan.current, message: res.error.message });
      return;
    }
    setScan({ status: "error", last: lastScan.current, message: res.error.message });
  }, [teamId, id]);

  const writeAll = useCallback(async (): Promise<number | null> => {
    let wrote = false;
    while (pending.current.size > 0 && !stopped.current) {
      const [path, text] = pending.current.entries().next().value as [string, string];
      pending.current.delete(path);
      setStatus("saving");
      const res = await putDraftFile(teamId, id, path, rev.current, text);
      if (!res.ok) {
        if (!pending.current.has(path)) pending.current.set(path, text);
        setError(res.error);
        if (res.error.code === "stale_revision") stopped.current = true;
        setStatus(res.error.code === "stale_revision" ? "conflict" : "error");
        return null;
      }
      changed(res.data);
      wrote = true;
      setFiles((fs) => fs.map((f) => (f.path === path ? { ...f, size: byteLength(text) } : f)));
    }
    if (stopped.current) return null;
    setError(null);
    setStatus("saved");
    // Only a write makes a new revision to scan (a flush before Save version may write nothing).
    if (wrote) void runScan();
    return rev.current;
  }, [teamId, id, changed, runScan]);

  const flush = useCallback((): Promise<number | null> => {
    for (const t of [idleTimer, maxTimer]) {
      if (t.current) clearTimeout(t.current);
      t.current = null;
    }
    const next = chain.current.then(() => writeAll());
    chain.current = next;
    return next;
  }, [writeAll]);

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
    void runScan();
  }, [loaded, runScan]);

  // Leaving with unsaved edits asks first; timers and requests stop with the page.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      for (const t of [idleTimer, maxTimer, retryTimer]) if (t.current) clearTimeout(t.current);
      scanAbort.current?.abort();
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
      const res = await readDraftText(teamId, id, path);
      if (!res.ok) return res.error;
      setTexts((t) => (t[path] === undefined ? { ...t, [path]: res.data } : t));
      return null;
    },
    [teamId, id, texts],
  );

  const addFile = useCallback(
    async (path: string) => {
      if ((await flush()) === null) return UNSAVED;
      const res = await putDraftFile(teamId, id, path, rev.current, "");
      if (!res.ok) return res.error;
      changed(res.data);
      const info: DraftFileInfo = {
        path,
        size: 0,
        kind: "text",
        updatedAt: res.data.draft.updatedAt,
      };
      setFiles((fs) => [...fs, info].sort((a, b) => a.path.localeCompare(b.path)));
      setTexts((t) => ({ ...t, [path]: "" }));
      void runScan();
      return null;
    },
    [teamId, id, flush, changed, runScan],
  );

  const removeFile = useCallback(
    async (path: string) => {
      pending.current.delete(path);
      if ((await flush()) === null) return UNSAVED;
      const res = await deleteDraftFile(teamId, id, path, rev.current);
      if (!res.ok) return res.error;
      changed(res.data);
      setFiles((fs) => fs.filter((f) => f.path !== path));
      setTexts((t) => Object.fromEntries(Object.entries(t).filter(([p]) => p !== path)));
      void runScan();
      return null;
    },
    [teamId, id, flush, changed, runScan],
  );

  // A new revision without new files (sharing): scanned again, since scans name revisions.
  const replaceDraft = useCallback(
    (next: DraftSummary) => {
      rev.current = next.rev;
      setDraft(next);
      void runScan();
    },
    [runScan],
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
    flush,
    replaceDraft,
  };
}
