"use client";

import { useState } from "react";
import {
  getFileDiff,
  getRawFile,
  type FileDiff,
  type RawFile,
  type VersionDiff,
} from "../../../lib/admin/api/site/skill-review";
import { visibleParts } from "../../../lib/admin/visible-text";
import { Badge, Button, EmptyState, Notice, type BadgeTone } from "../../ui/console";

const NOT_DIFFED: Readonly<Record<NonNullable<FileDiff["notDiffed"]>, string>> = {
  too_large: "too large to diff",
  too_different: "too different to diff line by line",
  skipped: "not diffed: the diff is too long",
};

/** Text with hidden characters shown as highlighted markers (review L4). */
function Visible({ text }: { readonly text: string }) {
  return (
    <>
      {visibleParts(text).map((p, i) =>
        p.hidden ? (
          <mark key={i} className="bg-status-attention-bg text-status-attention">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

const STATUS: Readonly<Record<FileDiff["status"], { label: string; tone: BadgeTone }>> = {
  changed: { label: "changed", tone: "attention" },
  added: { label: "added", tone: "running" },
  removed: { label: "removed", tone: "failed" },
  unchanged: { label: "unchanged", tone: "neutral" },
};

/** A patch line: added and removed lines are told apart by their sign and an sr-only word, not colour alone. */
function PatchLine({ line }: { readonly line: string }) {
  const sign = line[0];
  const tone =
    sign === "+"
      ? "bg-status-running-bg text-status-running"
      : sign === "-"
        ? "bg-status-failed-bg text-status-failed"
        : "";
  return (
    <span className={`block whitespace-pre-wrap ${tone}`}>
      {sign === "+" && <span className="sr-only">Added: </span>}
      {sign === "-" && <span className="sr-only">Removed: </span>}
      <Visible text={line} />
    </span>
  );
}

function Hunks({ file }: { readonly file: FileDiff }) {
  return (
    <>
      {file.hunks.map((h) => (
        <pre
          key={`${h.oldStart}-${h.newStart}`}
          aria-label={`${file.path}, lines ${h.newStart} to ${h.newStart + Math.max(h.newLines - 1, 0)}`}
          className="mt-2 overflow-x-auto rounded border border-console-border p-2 font-mono text-xs"
        >
          <span className="block text-console-muted">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </span>
          {h.lines.map((line, i) => (
            <PatchLine key={i} line={line} />
          ))}
        </pre>
      ))}
    </>
  );
}

type Extra =
  | { readonly kind: "diff"; readonly file: FileDiff }
  | { readonly kind: "raw"; readonly file: RawFile }
  | { readonly kind: "error"; readonly message: string };

/**
 * A changed file; one the request's budget skipped loads its own diff, and one too large or too
 * different to diff can be read whole (review-335 M2).
 */
function FilePatch({ file, versionId }: { readonly file: FileDiff; readonly versionId: string }) {
  const status = STATUS[file.status];
  const [extra, setExtra] = useState<Extra | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (kind: "diff" | "raw") => {
    setBusy(true);
    try {
      const res =
        kind === "diff"
          ? await getFileDiff(versionId, file.path)
          : await getRawFile(versionId, file.path);
      if (!res.ok) setExtra({ kind: "error", message: res.error.message });
      else if (kind === "diff") setExtra({ kind: "diff", file: res.data as FileDiff });
      else setExtra({ kind: "raw", file: res.data as RawFile });
    } finally {
      setBusy(false);
    }
  };
  const shown = extra?.kind === "diff" ? extra.file : file;
  const canRead = file.status !== "removed" && !file.binary;
  return (
    <details open={file.status !== "unchanged"} className="mt-3">
      <summary className="cursor-pointer">
        <code>
          <Visible text={file.path} />
        </code>{" "}
        <Badge tone={status.tone}>{status.label}</Badge>
        {file.binary && file.status !== "unchanged" && (
          <span className="ms-2 text-console-muted">binary</span>
        )}
        {shown.notDiffed && (
          <span className="ms-2 text-console-muted">{NOT_DIFFED[shown.notDiffed]}</span>
        )}
      </summary>
      {file.notDiffed === "skipped" && extra === null && (
        <Button size="sm" className="mt-2" disabled={busy} onClick={() => void load("diff")}>
          Load diff of {file.path}
        </Button>
      )}
      {shown.notDiffed && shown.notDiffed !== "skipped" && canRead && extra?.kind !== "raw" && (
        <Button size="sm" className="mt-2" disabled={busy} onClick={() => void load("raw")}>
          View {file.path}
        </Button>
      )}
      {extra?.kind === "error" && <Notice tone="error">{extra.message}</Notice>}
      {extra?.kind === "raw" && (
        <pre
          aria-label={`${file.path}, whole file`}
          className="mt-2 max-h-[40rem] overflow-auto rounded border border-console-border p-2 font-mono text-xs whitespace-pre-wrap"
        >
          {extra.file.text === null ? "Binary file." : <Visible text={extra.file.text} />}
          {extra.file.truncated && "\n… (the first 1 MiB)"}
        </pre>
      )}
      <Hunks file={shown} />
    </details>
  );
}

/**
 * The diff the review screen opens on (SK23): the submitted package against the approved version
 * (or, for a new skill, every file added); SKILL.md, the manifest and scripts first, open.
 */
export function ReviewDiff({
  diff,
  versionId,
}: {
  readonly diff: VersionDiff;
  readonly versionId: string;
}) {
  const changed = diff.files.filter((f) => f.status !== "unchanged");
  const same = diff.files.filter((f) => f.status === "unchanged");
  return (
    <div>
      <p>
        {diff.against
          ? `Against the approved version ${diff.against.semver}: ${diff.changedFiles} changed ${diff.changedFiles === 1 ? "file" : "files"}.`
          : `A new skill: every file is new (${diff.changedFiles}).`}
      </p>
      {diff.truncated && (
        <Notice tone="warn">
          The diff is long: some files show their status only. Load each one below.
        </Notice>
      )}
      {changed.length === 0 ? (
        <EmptyState title="No file changed." />
      ) : (
        changed.map((f) => <FilePatch key={f.path} file={f} versionId={versionId} />)
      )}
      {same.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer">Unchanged files ({same.length})</summary>
          <ul className="mt-2 list-disc ps-6">
            {same.map((f) => (
              <li key={f.path}>
                <code>
                  <Visible text={f.path} />
                </code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
