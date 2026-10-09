"use client";

import { FileIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { DraftFile } from "../../lib/chat/attachments";
import type { ChipFile } from "../../lib/chat/tree";
import { formatBytes } from "../../lib/chat/uploads";
import { useChatSession } from "./kobe-runtime";

const chip =
  "border-foreground/10 bg-background flex min-w-0 max-w-64 items-center gap-2 rounded-lg border px-2 py-1 text-xs";

function Thumb({ url }: { readonly url: string | undefined }) {
  // Decorative: the file name is the accessible label.
  return url ? (
    <img src={url} alt="" className="size-8 shrink-0 rounded object-cover" />
  ) : (
    <FileIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
  );
}

/** Live view of a draft's files. */
export function useDraftFiles(draft: string): readonly DraftFile[] {
  const { attachments } = useChatSession();
  const get = () => attachments.get(draft);
  return useSyncExternalStore(attachments.subscribe, get, get);
}

function Status({ file }: { readonly file: DraftFile }) {
  if (file.status === "error") {
    return (
      <span role="alert" className="text-destructive whitespace-normal">
        {file.error?.message}
      </span>
    );
  }
  if (file.status === "uploading") {
    const percent = Math.round(file.progress * 100);
    return (
      <progress
        className="h-1 w-full"
        max={100}
        value={percent}
        aria-label={`Uploading ${file.name}`}
        aria-valuetext={`${percent}%`}
      />
    );
  }
  return <span className="text-muted-foreground">Ready</span>;
}

/** The files of the composer's draft: progress, errors, remove and retry. */
export function ComposerAttachments({
  draft,
  threadId,
}: {
  readonly draft: string;
  readonly threadId: string | undefined;
}) {
  const session = useChatSession();
  const files = useDraftFiles(draft);
  if (files.length === 0) return null;
  return (
    <ul aria-label="Attached files" className="flex flex-wrap gap-1.5 px-1">
      {files.map((file) => (
        <li key={file.id} className={chip}>
          <Thumb url={file.previewUrl} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium" title={file.name}>
              {file.name}{" "}
              <span className="text-muted-foreground font-normal">{formatBytes(file.size)}</span>
            </span>
            <Status file={file} />
          </span>
          {file.status === "error" && file.error?.retryable && (
            <button
              type="button"
              aria-label={`Retry ${file.name}`}
              className="hover:bg-muted rounded p-1"
              onClick={() => session.attachments.retry(draft, file.id, threadId)}
            >
              <RotateCwIcon aria-hidden className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            className="hover:bg-muted rounded p-1"
            onClick={() => session.attachments.remove(draft, file.id)}
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The files on a sent message. */
export function SentAttachments({ files }: { readonly files: readonly ChipFile[] }) {
  const { attachments } = useChatSession();
  return (
    <ul aria-label="Attached files" className="flex flex-wrap justify-end gap-1.5">
      {files.map((file, i) => {
        const size = file.size ?? attachments.sizeOf(file.name);
        return (
          <li key={`${file.name}-${i}`} className={chip}>
            <Thumb url={file.previewUrl} />
            <span className="truncate" title={file.name}>
              {file.name}
              {size !== undefined && (
                <span className="text-muted-foreground"> {formatBytes(size)}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
