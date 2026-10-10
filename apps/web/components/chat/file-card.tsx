"use client";

/**
 * The download card for `file.shared` (KOBE-152): name, size, type and a Download button. The
 * bytes come from `GET /v1/files/:id/content` (KOBE-150), which only the thread's readers get; a
 * refused scan or a missing object shows as a plain message, never as a broken link.
 */
import { useContext, useState } from "react";
import { DownloadIcon, FileIcon } from "lucide-react";
import type { KobeEventPayload } from "@kobe/protocol";
import type { ApiError } from "../../lib/api/client";
import { formatBytes } from "../../lib/files/format";
import { saveBytes } from "../../lib/files/save";
import { ChatSessionContext } from "./kobe-runtime";
import styles from "./chat.module.css";

/** The words for a failed download; 404 covers a rejected scan and a thread you cannot read. */
export function describeDownloadError(error: ApiError): string {
  if (error.status === 404) return "This file is no longer available.";
  if (error.status === 503) return "The file store is unavailable right now. Try again shortly.";
  if (error.status === 0) return "Could not reach the server. Check your connection and try again.";
  return "The download failed. Try again.";
}

export function FileCard({ file }: { readonly file: KobeEventPayload<"file.shared"> }) {
  const api = useContext(ChatSessionContext)?.api;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    const res = await api.downloadSharedFile(file.file_id);
    setBusy(false);
    if (!res.ok) return setError(describeDownloadError(res.error));
    saveBytes(file.name, res.data);
  };

  return (
    <div className={styles.fileCard}>
      <FileIcon aria-hidden className="size-4" />
      <div className={styles.fileInfo}>
        <span className={styles.fileName}>{file.name}</span>
        <span className={styles.fileMeta}>
          {formatBytes(file.size)}
          {file.mime_type ? ` · ${file.mime_type}` : ""}
        </span>
        {file.description && <span className={styles.fileMeta}>{file.description}</span>}
        {error && (
          <span role="alert" className={styles.errorText}>
            {error}
          </span>
        )}
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs"
        aria-label={`Download ${file.name}`}
        disabled={busy || !api}
        onClick={() => void download()}
      >
        <DownloadIcon aria-hidden className="size-3" />
        {busy ? "Downloading…" : "Download"}
      </button>
    </div>
  );
}
