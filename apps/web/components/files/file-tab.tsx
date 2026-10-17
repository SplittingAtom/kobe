"use client";

/**
 * A workspace file as a tab of the artifact column (KOBE-268): view-only, from the synced
 * workspace (so it works while the sandbox hibernates and shows the last-synced version). The read
 * itself tells whether the file still exists (404: `onGone`, its tab closes) and its size
 * (Content-Length); files that aren't shown inline (HTML, PDF, unknown) are read headers only. Renderers reuse the artifact views:
 * Markdown, CSV/TSV tables, code and text as fenced blocks, JSON pretty-printed, images and SVG
 * as `<img>` from a `data:` URL (never inline SVG markup), HTML in the sandboxed frame served by
 * `/v1/workspace/frame` (same sandbox and CSP as artifact frames). PDFs and anything else:
 * Cannot preview, with Download. Text is read up to 1 MB; large images are not fetched.
 */
import { useEffect, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { describeFileError, formatBytes } from "../../lib/files/format";
import {
  decodePreviewText,
  fileName,
  HTML_FRAME_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  imageDataUrl,
  previewOf,
  TEXT_PREVIEW_MAX_BYTES,
  workspaceFrameUrl,
  type FilePreview,
} from "../../lib/files/preview";
import { saveBytes } from "../../lib/files/save";
import { ARTIFACT_FRAME_SANDBOX, fenced } from "../../lib/chat/artifacts";
import { ErrorNotice } from "../admin/error-notice";
import { useArtifactPanel } from "../chat/artifact-state";
import { CsvTable } from "../chat/artifact-views";
import { Markdown } from "../chat/markdown";
import { IconAction } from "../shell/icon-action";
import styles from "../chat/chat.module.css";

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "none" | "frame" }
  | { readonly status: "too_large"; readonly size: number | null }
  | { readonly status: "image"; readonly src: string }
  | {
      readonly status: "text";
      readonly text: string;
      readonly truncated: boolean;
      readonly size: number | null;
    };

const GONE = "gone";

/** The bytes to read for a preview, and whether only the whole file will do. */
function readPlan(preview: FilePreview): { readonly max: number; readonly wholeOnly: boolean } {
  switch (preview.kind) {
    case "none":
    case "html":
      return { max: 0, wholeOnly: true }; // headers only: whether it exists, and its size
    case "image":
    case "svg":
      return { max: IMAGE_PREVIEW_MAX_BYTES, wholeOnly: true };
    default:
      return { max: TEXT_PREVIEW_MAX_BYTES, wholeOnly: false };
  }
}

/** What the tab shows for `path`, or GONE when the read says the file no longer exists. */
async function load(api: FilesApi, path: string, preview: FilePreview): Promise<Loaded | "gone"> {
  const plan = readPlan(preview);
  const read = await api.read(path, plan.max, plan.wholeOnly);
  if (!read.ok) {
    return read.error.status === 404
      ? GONE
      : { status: "error", error: describeFileError(read.error) };
  }
  const { bytes, truncated, size } = read.data;
  switch (preview.kind) {
    case "none":
      return { status: "none" };
    case "html":
      return size !== null && size > HTML_FRAME_MAX_BYTES
        ? { status: "too_large", size }
        : { status: "frame" };
    case "image":
    case "svg":
      return truncated
        ? { status: "too_large", size }
        : { status: "image", src: imageDataUrl(bytes, preview.mime) };
    default: {
      const text = decodePreviewText(bytes, truncated);
      return text === null ? { status: "none" } : { status: "text", text, truncated, size };
    }
  }
}

/** The file's preview, read again on each new `reload` (the member opened it again). */
function useFilePreview(
  api: FilesApi,
  path: string,
  reload: number,
  onGone: (path: string) => void,
): Loaded {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  useEffect(() => {
    let current = true;
    void load(api, path, previewOf(path)).then((loaded) => {
      if (!current) return;
      if (loaded === GONE) onGone(path);
      else setState(loaded);
    });
    return () => {
      current = false;
    };
  }, [api, path, reload, onGone]);
  return state;
}

/** JSON pretty-printed; a cut or invalid file as it is. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

function TextView({ text, preview }: { readonly text: string; readonly preview: FilePreview }) {
  switch (preview.kind) {
    case "markdown":
      return <Markdown text={text} />;
    case "csv":
    case "tsv":
      return <CsvTable text={text} delimiter={preview.kind === "tsv" ? "\t" : ","} />;
    case "json":
      return <Markdown text={fenced(prettyJson(text), "json")} />;
    case "code":
      return <Markdown text={fenced(text, preview.language)} />;
    default:
      return <Markdown text={fenced(text, null)} />;
  }
}

function CannotPreview({ reason }: { readonly reason: string }) {
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {reason} Use Download to get it.
    </p>
  );
}

function FileBody({
  loaded,
  path,
  teamId,
}: {
  readonly loaded: Loaded;
  readonly path: string;
  readonly teamId: string;
}) {
  const name = fileName(path);
  switch (loaded.status) {
    case "loading":
      return <p role="status">Loading the file…</p>;
    case "error":
      return <ErrorNotice error={loaded.error} />;
    case "none":
      return <CannotPreview reason="Cannot preview this file." />;
    case "too_large":
      return (
        <CannotPreview
          reason={
            loaded.size === null
              ? "This file is too large to preview."
              : `This file is too large to preview (${formatBytes(loaded.size)}).`
          }
        />
      );
    case "frame":
      return (
        <iframe
          title={name}
          src={workspaceFrameUrl(path, teamId)}
          sandbox={ARTIFACT_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="h-full min-h-80 w-full rounded-md border bg-white"
        />
      );
    case "image":
      return <img src={loaded.src} alt={name} className="max-w-full" />;
    case "text":
      return (
        <>
          {loaded.truncated && (
            <p role="status" className="text-muted-foreground mb-2 text-xs">
              {`Showing the first ${formatBytes(TEXT_PREVIEW_MAX_BYTES)}${
                loaded.size === null ? "" : ` of ${formatBytes(loaded.size)}`
              }. Download the file for all of it.`}
            </p>
          )}
          <TextView text={loaded.text} preview={previewOf(path)} />
        </>
      );
  }
}

/** One file tab's header (name, Download) and body. `titleId` labels the column. */
export function FileTabContent({
  path,
  api,
  teamId,
  titleId,
  reload,
  onGone,
}: {
  readonly path: string;
  readonly api: FilesApi;
  readonly teamId: string;
  readonly titleId: string;
  /** A new value reads the file again (it was opened again from Files). */
  readonly reload: number;
  onGone(path: string): void;
}) {
  const loaded = useFilePreview(api, path, reload, onGone);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);
  const name = fileName(path);
  const download = async () => {
    setDownloadError(null);
    const res = await api.download(path);
    if (res.ok) saveBytes(name, res.data);
    else setDownloadError(describeFileError(res.error));
  };
  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium" title={path}>
          {name}
        </h2>
        <IconAction
          command="artifact-download"
          label={`Download ${name}`}
          onClick={() => void download()}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {downloadError && <ErrorNotice error={downloadError} />}
        <FileBody loaded={loaded} path={path} teamId={teamId} />
      </div>
    </>
  );
}

/** Says which file's tab closed because the file left the workspace (until dismissed). */
export function FileGoneNotice() {
  const panel = useArtifactPanel();
  const gone = panel?.goneFile ?? null;
  if (!panel || gone === null) return null;
  return (
    <div className={styles.dismissibleBanner} role="status">
      <p>{`${fileName(gone)} is no longer in your workspace (moved, renamed or deleted), so its tab was closed.`}</p>
      <IconAction
        command="dismiss-notice"
        label="Dismiss file notice"
        size="sm"
        className="shrink-0"
        onClick={panel.dismissGone}
      />
    </div>
  );
}
