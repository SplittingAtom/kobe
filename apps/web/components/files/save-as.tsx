"use client";

/**
 * Save As (KOBE-615): the editor's text, unsaved changes included, saved to a new path of My
 * files, then opened in the tab. Never a silent overwrite: the save names no version, so the
 * server creates the file or answers 409 when one is there; Replace then saves over exactly the
 * version it finds (the listing's SHA-256), and a file that changed again in between is refused
 * again, never overwritten. The form opens under the toolbar, takes the focus, and Escape cancels.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { describeFileError, formatBytes } from "../../lib/files/format";
import { fileVersion } from "../../lib/files/outside-change";
import { TEXT_PREVIEW_MAX_BYTES } from "../../lib/files/preview";
import { defaultSaveAsPath, saveAsProblem } from "../../lib/files/save-as";
import { ErrorNotice } from "../admin/error-notice";
import { TOOL_BUTTON } from "./editor-toolbar";

export const CHANGED_AGAIN_NOTE =
  "That file changed again while you decided, so nothing was saved. Replace again to save over the newest version.";
const UNKNOWN_VERSION: ApiError = {
  status: 409,
  code: "version_conflict",
  message: "Could not read that file's version, so nothing was saved. Try again.",
};

type Step =
  | { readonly kind: "edit" }
  | { readonly kind: "saving" }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "error"; readonly error: ApiError };

/** Saves `text` at `path` over the version there now (Replace); "conflict": it moved on again. */
async function replace(
  api: FilesApi,
  path: string,
  text: string,
): Promise<"saved" | "conflict" | ApiError> {
  const version = await fileVersion(api, path);
  if (version.kind === "unknown") return UNKNOWN_VERSION;
  const res = await api.save(path, version.kind === "version" ? version.sha256 : "", text);
  if (res.ok) return "saved";
  return res.error.code === "version_conflict" ? "conflict" : describeFileError(res.error);
}

export function SaveAsForm({
  api,
  path,
  text,
  truncated,
  checkedOut,
  onSaved,
  onCancel,
}: {
  readonly api: FilesApi;
  /** The file open now. */
  readonly path: string;
  /** What is saved: the editor's text as shown. */
  readonly text: string;
  /** The text is the first part of a larger file (only that part is saved). */
  readonly truncated: boolean;
  readonly checkedOut?: ReadonlySet<string> | undefined;
  onSaved(path: string): void;
  onCancel(): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState(() => defaultSaveAsPath(path, checkedOut));
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "edit" });
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // The name without its extension is selected, as in a desktop Save As.
    const slash = el.value.lastIndexOf("/") + 1;
    const dot = el.value.lastIndexOf(".");
    el.setSelectionRange(slash, dot > slash ? dot : el.value.length);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const issue = saveAsProblem(target, path, checkedOut);
    setProblem(issue);
    setNote(null);
    if (issue !== null) return;
    setStep({ kind: "saving" });
    const res = await api.save(target, "", text);
    if (res.ok) return onSaved(target);
    setStep(
      res.error.code === "version_conflict"
        ? { kind: "exists", path: target }
        : { kind: "error", error: describeFileError(res.error) },
    );
  };
  const confirmReplace = async (at: string) => {
    setStep({ kind: "saving" });
    setNote(null);
    const result = await replace(api, at, text);
    if (result === "saved") return onSaved(at);
    if (result === "conflict") {
      setNote(CHANGED_AGAIN_NOTE);
      setStep({ kind: "exists", path: at });
      return;
    }
    setStep({ kind: "error", error: result });
  };
  const busy = step.kind === "saving";
  return (
    <div
      role="dialog"
      aria-labelledby={`${id}-t`}
      className="mt-1 flex shrink-0 flex-col gap-1.5 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <form className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
        <label id={`${id}-t`} htmlFor={`${id}-i`} className="font-medium">
          Save as
        </label>
        <input
          ref={input}
          id={`${id}-i`}
          value={target}
          maxLength={1024}
          spellCheck={false}
          aria-invalid={problem !== null}
          aria-describedby={`${id}-h${problem ? ` ${id}-p` : ""}`}
          className="border-input bg-background rounded-md border px-1.5 py-0.5 font-mono text-sm"
          onChange={(e) => {
            setTarget(e.currentTarget.value);
            if (step.kind !== "saving") setStep({ kind: "edit" });
          }}
        />
        <p id={`${id}-h`} className="text-muted-foreground m-0">
          {`A path in My files, for example notes/copy.md.${
            truncated
              ? ` Only the first ${formatBytes(TEXT_PREVIEW_MAX_BYTES)} shown here is saved.`
              : ""
          }`}
        </p>
        {problem && (
          <p id={`${id}-p`} role="alert" className="text-destructive m-0">
            {problem}
          </p>
        )}
        {step.kind === "exists" ? (
          <div role="alertdialog" aria-labelledby={`${id}-x`} className="flex flex-col gap-1">
            <p id={`${id}-x`} className="m-0">
              {`${step.path} already exists. Replace it with this text?`}
            </p>
            {note && (
              <p role="alert" className="m-0">
                {note}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={TOOL_BUTTON}
                onClick={() => setStep({ kind: "edit" })}
              >
                Keep it
              </button>
              <button
                type="button"
                className={`${TOOL_BUTTON} text-destructive border-destructive/40`}
                onClick={() => void confirmReplace(step.path)}
              >
                Replace
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" className={TOOL_BUTTON} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className={TOOL_BUTTON} disabled={busy}>
              {busy ? "Saving…" : "Save copy"}
            </button>
          </div>
        )}
        {step.kind === "error" && <ErrorNotice error={step.error} />}
      </form>
    </div>
  );
}
