"use client";

/**
 * The Rendered/Raw modes shared by the file editor (KOBE-463) and text artifacts (KOBE-485): the
 * mode toolbar, and the body that shows a text either rendered (`TextView`, the safe renderers) or
 * raw in CodeMirror (loaded lazily, with the page's CSP nonce), editable or read-only.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { editorLanguage } from "../../lib/files/editor";
import type { FilePreview } from "../../lib/files/preview";
import { TextView } from "./text-view";

export const CodeEditor = lazy(() => import("./code-editor"));

export type TextMode = "rendered" | "raw";

export const BUTTON = "hover:bg-muted rounded-md border px-2 py-0.5 text-xs disabled:opacity-50";

export function EditorFallback() {
  return <p role="status">Loading the editor…</p>;
}

/** Rendered and Raw as pressed buttons; `children` (Save, Edit as file) sit at the end. */
export function TextModeToolbar({
  label,
  mode,
  onMode,
  children,
}: {
  /** The toolbar's accessible name. */
  readonly label: string;
  readonly mode: TextMode;
  onMode(mode: TextMode): void;
  readonly children?: ReactNode;
}) {
  return (
    <div role="toolbar" aria-label={label} className="flex items-center gap-1">
      {(["rendered", "raw"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          className={`${BUTTON} aria-pressed:bg-muted`}
          onClick={() => onMode(m)}
        >
          {m === "rendered" ? "Rendered" : "Raw"}
        </button>
      ))}
      {children}
    </div>
  );
}

/** The text in the chosen mode; without `onChange` (or with `readOnly`) Raw cannot be edited. */
export function TextModeBody({
  mode,
  text,
  preview,
  label,
  readOnly,
  onChange,
}: {
  readonly mode: TextMode;
  readonly text: string;
  readonly preview: FilePreview;
  /** The Raw editor's accessible name. */
  readonly label: string;
  readonly readOnly: boolean;
  readonly onChange?: ((text: string) => void) | undefined;
}) {
  if (mode === "rendered") return <TextView text={text} preview={preview} />;
  return (
    <Suspense fallback={<EditorFallback />}>
      <CodeEditor
        value={text}
        language={editorLanguage(preview)}
        label={label}
        readOnly={readOnly || onChange === undefined}
        {...(onChange ? { onChange } : {})}
      />
    </Suspense>
  );
}
