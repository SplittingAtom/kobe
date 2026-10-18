"use client";

import { WORKSPACE_DROP_FOLDER } from "@kobe/protocol";
import { UploadIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import {
  carriesFiles,
  droppedItems,
  folderError,
  uploadDropped,
  type DroppedItems,
} from "../../lib/files/drop";
import { ErrorNotice } from "../admin/error-notice";
import type { RailApi } from "./rail-state";
import styles from "./rail.module.css";

/**
 * The whole rail is the drop zone (CE5, KOBE-199): while files are dragged over it, a full-rail
 * overlay; a drop uploads them into `/workspace/uploads/` and shows them in Files. Over a folder
 * of the Files tree the tree takes the drop into that folder instead (KOBE-304); the overlay lets
 * the pointer through to it. A drop never
 * touches the composer (its own drop attaches to the message, KOBE-145). No zone on touch devices.
 */

/** Touch-first devices (no hover, coarse pointer) cannot drag files onto the rail. */
const TOUCH_QUERY = "(hover: none), (pointer: coarse)";

/** Decided after mount, so the server render and the first client render match (no zone). */
function useDropSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const touch = typeof window.matchMedia === "function" && window.matchMedia(TOUCH_QUERY).matches;
    setSupported(!touch);
  }, []);
  return supported;
}

function outsideViewport(e: globalThis.DragEvent): boolean {
  const { clientX: x, clientY: y } = e;
  return x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight;
}

/**
 * Over a folder of the Files tree that takes files (KOBE-304, `DROP_FOLDER_ATTR`): the tree
 * uploads into that folder, so the rail's zone stands aside (no overlay, no uploads/ drop).
 */
function overTreeFolder(e: DragEvent): boolean {
  const target = e.target instanceof Element ? e.target : null;
  return target?.closest("[data-kobe-drop-folder]") != null;
}

type RailDragHandlers = {
  readonly [K in "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"]?: (e: DragEvent) => void;
};

/**
 * Whether files are over the rail. Enter/leave pairs are counted, so moving between the rail's own
 * children never flickers; dragover re-arms a count that drifted. Cleared on drop, on dragend and
 * when the drag leaves the window.
 */
function useRailDrag(enabled: boolean, onDrop: (items: DroppedItems) => void) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const reset = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const leftWindow = (e: globalThis.DragEvent) => {
      if (e.relatedTarget == null && outsideViewport(e)) reset();
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    document.addEventListener("dragleave", leftWindow);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      document.removeEventListener("dragleave", leftWindow);
    };
  }, [enabled, reset]);

  const handlers: RailDragHandlers = !enabled
    ? {}
    : {
        onDragEnter: (e) => {
          if (!carriesFiles(e.dataTransfer) || overTreeFolder(e)) return;
          e.preventDefault();
          depth.current += 1;
          setActive(true);
        },
        onDragOver: (e) => {
          if (!carriesFiles(e.dataTransfer)) return;
          if (overTreeFolder(e)) return setActive(false);
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          depth.current = Math.max(depth.current, 1);
          setActive(true);
        },
        onDragLeave: (e) => {
          if (!carriesFiles(e.dataTransfer)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setActive(false);
        },
        onDrop: (e) => {
          if (!carriesFiles(e.dataTransfer) || overTreeFolder(e)) return;
          e.preventDefault();
          const items = droppedItems(e.dataTransfer); // only readable during the event
          reset();
          onDrop(items);
        },
      };
  return { active, handlers };
}

export interface DropStatus {
  readonly busy: boolean;
  readonly notice: string;
  readonly errors: readonly ApiError[];
}

/** How long "Added … to uploads." stays before it clears itself. */
export const DROP_NOTICE_MS = 8000;
const IDLE: DropStatus = { busy: false, notice: "", errors: [] };
const UNEXPECTED: ApiError = {
  status: 0,
  code: "drop_failed",
  message: "Those files could not be added. Try again.",
};
const plural = (n: number) => (n === 1 ? "1 file" : `${n} files`);

/** Drops that overlap (one lands while another uploads) form one batch with one status. */
interface Batch {
  readonly pending: number;
  readonly added: readonly string[];
  readonly errors: readonly ApiError[];
}

function batchStatus(batch: Batch): DropStatus {
  if (batch.pending > 0) {
    return {
      busy: true,
      notice: `Adding ${plural(batch.pending)} to your workspace…`,
      errors: batch.errors,
    };
  }
  const notice = batch.added.length > 0 ? `Added ${batch.added.join(", ")} to uploads.` : "";
  return { busy: false, notice, errors: batch.errors };
}

/** The success notice clears itself; errors stay until the next drop or Files action. */
function useDropStatus() {
  const [status, setStatus] = useState<DropStatus>(IDLE);
  const done = !status.busy && status.notice !== "";
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setStatus((s) => ({ ...s, notice: "" })), DROP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [done, status.notice]);
  const clear = useCallback(() => setStatus((s) => (s.busy ? s : IDLE)), []);
  return { status, setStatus, clear };
}

/**
 * The rail's drop zone: drag handlers for the rail, the overlay flag, the drops' outcome and the
 * folder Files should show. Drops upload one after another into uploads/; when the batch is done
 * Files is revealed (first use wakes and lists, later ones list again) on uploads/.
 */
export function useRailDropZone(api: FilesApi, rail: RailApi) {
  const { status, setStatus, clear } = useDropStatus();
  const [showFolder, setShowFolder] = useState<{ path: string; seq: number } | null>(null);
  const { reveal, setCollapsed } = rail;
  const batch = useRef<Batch | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const finish = useCallback(
    (done: Batch) => {
      if (done.added.length === 0) return setCollapsed(false); // the notice is in Files
      setShowFolder((prev) => ({ path: WORKSPACE_DROP_FOLDER, seq: (prev?.seq ?? 0) + 1 }));
      reveal("files");
    },
    [reveal, setCollapsed],
  );

  const enqueue = useCallback(
    ({ files, folders }: DroppedItems) => {
      const prev = batch.current ?? { pending: 0, added: [], errors: [] };
      const refused = folders.length > 0 ? [folderError(folders)] : [];
      batch.current = {
        ...prev,
        pending: prev.pending + files.length,
        errors: [...prev.errors, ...refused],
      };
      setStatus(batchStatus(batch.current));
      queue.current = queue.current.then(async () => {
        const out = files.length > 0 ? await uploadDropped(api, files) : { added: [], errors: [] };
        const cur = batch.current ?? prev;
        const next: Batch = {
          pending: cur.pending - files.length,
          added: [...cur.added, ...out.added],
          errors: [...cur.errors, ...out.errors],
        };
        batch.current = next.pending > 0 ? next : null;
        setStatus(batchStatus(next));
        if (next.pending === 0) finish(next);
      });
      // Never leave the queue rejected: later drops must still run.
      queue.current = queue.current.catch((err: unknown) => {
        console.error("rail drop: upload failed", err);
        batch.current = null;
        setStatus({ busy: false, notice: "", errors: [UNEXPECTED] });
      });
    },
    [api, finish, setStatus],
  );
  const drag = useRailDrag(useDropSupported(), enqueue);
  return { ...drag, status, showFolder, clear };
}

export function RailDropOverlay() {
  return (
    <div className={styles.dropOverlay} data-rail-drop-overlay="">
      <UploadIcon aria-hidden className="size-5 shrink-0" />
      <p className={styles.dropText}>Drop to add to your workspace</p>
    </div>
  );
}

/** The last drop's outcome, at the top of Files: the same error notice Files uses. */
export function RailDropNotice({ status }: { readonly status: DropStatus }) {
  return (
    <div className={styles.dropNotice}>
      {status.errors.map((error, i) => (
        <ErrorNotice key={`${i}:${error.message}`} error={error} />
      ))}
      <p role="status" className="text-muted-foreground m-0 text-xs">
        {status.notice}
      </p>
    </div>
  );
}
