"use client";

import { UploadIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import {
  carriesFiles,
  DROP_FOLDER,
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
 * overlay; a drop uploads them into `/workspace/uploads/` and shows them in Files. A drop never
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
          if (!carriesFiles(e.dataTransfer)) return;
          e.preventDefault();
          depth.current += 1;
          setActive(true);
        },
        onDragOver: (e) => {
          if (!carriesFiles(e.dataTransfer)) return;
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
          if (!carriesFiles(e.dataTransfer)) return;
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

const IDLE: DropStatus = { busy: false, notice: "", errors: [] };
const plural = (n: number) => (n === 1 ? "1 file" : `${n} files`);

/**
 * The rail's drop zone: drag handlers for the rail, the overlay flag, the last drop's outcome and
 * the folder Files should show. Files land in uploads/; Files is revealed (first use wakes and
 * lists, later ones list again) and opens uploads/ once something was added.
 */
export function useRailDropZone(api: FilesApi, rail: RailApi) {
  const [status, setStatus] = useState<DropStatus>(IDLE);
  const [showFolder, setShowFolder] = useState<{ path: string; seq: number } | null>(null);
  const { reveal, setCollapsed } = rail;
  const upload = useCallback(
    async ({ files, folders }: DroppedItems) => {
      const refused = folders.length > 0 ? [folderError(folders)] : [];
      if (files.length > 0) {
        setStatus({
          busy: true,
          notice: `Adding ${plural(files.length)} to your workspace…`,
          errors: refused,
        });
      }
      const { added, errors } =
        files.length > 0 ? await uploadDropped(api, files) : { added: [], errors: [] };
      setStatus({
        busy: false,
        notice: added.length > 0 ? `Added ${added.join(", ")} to uploads.` : "",
        errors: [...refused, ...errors],
      });
      if (added.length === 0) return setCollapsed(false); // the notice is in Files
      setShowFolder((prev) => ({ path: DROP_FOLDER, seq: (prev?.seq ?? 0) + 1 }));
      reveal("files");
    },
    [api, reveal, setCollapsed],
  );
  const drag = useRailDrag(useDropSupported(), (items) => void upload(items));
  return { ...drag, status, showFolder };
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
      <p role="status" className="text-muted-foreground text-xs">
        {status.notice}
      </p>
    </div>
  );
}
