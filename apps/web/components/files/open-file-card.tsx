"use client";

/**
 * The card under an `open_file` call (KOBE-484): "Opened <name>" with Open again. On a live
 * `file.opened` event (the controller's `fileOpenRequest`, never a replayed backlog) the thread's
 * owner gets that file's tab opened and focused once: text files in the editor, other types in
 * their viewers (the file tab decides). After a reload nothing opens by itself; Open again does.
 * A member reading a shared thread sees the card without Open again: the file tab reads the
 * viewer's own workspace, never the owner's.
 */
import { FileSearchIcon } from "lucide-react";
import { useEffect } from "react";
import { workspaceToolPath, type KobeEventPayload } from "@kobe/protocol";
import { fileName } from "../../lib/files/preview";
import { useArtifactPanel } from "../chat/artifact-state";
import { useKobeExtras } from "../chat/kobe-runtime";
import styles from "../chat/chat.module.css";

/** Requests this page already acted on (`<run>:<tool call>`): a remounted card never reopens. */
const handled = new Set<string>();

/** The opened file: the server's record while the run streams, else the call's own path. */
function openedPath(
  live: KobeEventPayload<"file.opened"> | undefined,
  args: unknown,
): string | undefined {
  if (live !== undefined) return live.path;
  const path = (args as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? workspaceToolPath(path) : undefined;
}

export function OpenFileCard({
  toolCallId,
  live,
  args,
  done,
  failed,
}: {
  readonly toolCallId: string;
  /** The `file.opened` event of this call, while the run streams. */
  readonly live: KobeEventPayload<"file.opened"> | undefined;
  /** The call's input (after a reload, the only record of the path). */
  readonly args: unknown;
  readonly done: boolean;
  /** The call failed or was denied: nothing was opened. */
  readonly failed: boolean;
}) {
  const panel = useArtifactPanel();
  const extras = useKobeExtras();
  const readOnly = extras?.state.summary?.readOnly === true;
  const request = extras?.state.fileOpenRequest;
  useEffect(() => {
    if (request?.toolCallId !== toolCallId || readOnly || !panel) return;
    const key = `${request.runId}:${toolCallId}`;
    if (handled.has(key)) return;
    handled.add(key);
    panel.openFile(request.path);
  }, [request, toolCallId, readOnly, panel]);
  if (failed || (live === undefined && !done)) return null;
  const path = openedPath(live, args);
  if (path === undefined) return null;
  const name = fileName(path);
  return (
    <div className={styles.fileCard} data-kobe-opened-file={path}>
      <FileSearchIcon aria-hidden className="size-4" />
      <div className={styles.fileInfo}>
        <span className={styles.fileName} title={path}>
          Opened {name}
        </span>
      </div>
      {!readOnly && panel && (
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs"
          aria-label={`Open ${name} again`}
          onClick={() => panel.openFile(path)}
        >
          Open again
        </button>
      )}
    </div>
  );
}
