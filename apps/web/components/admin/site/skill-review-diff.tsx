"use client";

import type { FileDiff, VersionDiff } from "../../../lib/admin/api/site/skill-review";
import { visibleParts } from "../../../lib/admin/visible-text";
import { Badge, EmptyState, Notice, type BadgeTone } from "../../ui/console";

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

function FilePatch({ file }: { readonly file: FileDiff }) {
  const status = STATUS[file.status];
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
        {file.notDiffed && (
          <span className="ms-2 text-console-muted">{NOT_DIFFED[file.notDiffed]}</span>
        )}
      </summary>
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
    </details>
  );
}

/**
 * The diff the review screen opens on (SK23): the submitted package against the approved version
 * (or, for a new skill, every file added); changed files first, open.
 */
export function ReviewDiff({ diff }: { readonly diff: VersionDiff }) {
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
          The diff is long: some files show their status only. Read them in the package.
        </Notice>
      )}
      {changed.length === 0 ? (
        <EmptyState title="No file changed." />
      ) : (
        changed.map((f) => <FilePatch key={f.path} file={f} />)
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
