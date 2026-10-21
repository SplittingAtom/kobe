"use client";

/**
 * The Raw view of a workspace text file (KOBE-463): a CodeMirror 6 editor, loaded lazily by
 * `file-editor.tsx` (`React.lazy`), so the chat bundle does not carry it. With `original`, it is
 * the review of an agent's proposal (spec FE3, FE10): `@codemirror/merge`'s unified view shows the
 * proposal against the file, added text on green and deleted text on red (struck through), with
 * Accept and Reject on each change. Accepting keeps a change, rejecting puts the original back;
 * the document is always what a commit saves. The toolbar does the same from the keyboard, on the
 * change at the cursor.
 */
import { useEffect, useRef, useState } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  acceptChunk,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  rejectChunk,
  unifiedMergeView,
} from "@codemirror/merge";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import type { EditorLanguage } from "../../lib/files/editor";
import { documentCspNonce } from "../../lib/security/csp-nonce";
import { languageExtension } from "./editor-languages";

export interface CodeEditorProps {
  readonly value: string;
  readonly language: EditorLanguage | null;
  /** The editable region's accessible name. */
  readonly label: string;
  readonly readOnly?: boolean | undefined;
  /** Review mode: `value` (the proposal) is shown against this content. */
  readonly original?: string | undefined;
  onChange?(text: string): void;
  /** Review mode: how many changes are still open (neither accepted nor rejected). */
  onChunks?(count: number): void;
  /** A notebook cell (KOBE-465): as tall as its text, not the file editor's full column. */
  readonly compact?: boolean | undefined;
  /** Shift+Enter runs (a notebook cell, KOBE-465) instead of inserting a line. */
  readonly onRun?: (() => void) | undefined;
}

/** Colours only from the theme tokens (app/theme.css), so light and dark both hold. */
const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "0.8125rem",
    height: "100%",
  },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--muted) 50%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--ring) 35%, transparent)",
  },
  // The diff (unified merge view): added on green, deleted on red and struck through.
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "var(--kobe-diff-added-bg)",
  },
  "&.cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--kobe-diff-added) 25%, var(--kobe-diff-added-bg))",
  },
  ".cm-deletedChunk": { backgroundColor: "var(--kobe-diff-deleted-bg)" },
  ".cm-deletedChunk del, &.cm-merge-b .cm-deletedText": {
    textDecoration: "line-through",
    textDecorationColor: "var(--kobe-diff-deleted)",
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    background: "color-mix(in srgb, var(--kobe-diff-deleted) 25%, var(--kobe-diff-deleted-bg))",
  },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--kobe-diff-added)" },
  ".cm-deletedLineGutter": { background: "var(--kobe-diff-deleted)" },
  ".cm-deletedChunk .cm-chunkButtons": { display: "flex", gap: "0.25rem", padding: "0.125rem 0" },
  ".cm-chunkButtons button": {
    border: "1px solid currentColor",
    borderRadius: "0.25rem",
    padding: "0 0.5rem",
    fontSize: "0.75rem",
    background: "var(--background)",
    cursor: "pointer",
  },
  ".cm-chunkButtons button[name=accept]": { color: "var(--kobe-diff-added)" },
  ".cm-chunkButtons button[name=reject]": { color: "var(--kobe-diff-deleted)" },
});

/** Accept and Reject as real buttons (click, so Enter and Space work too), with full names. */
function chunkButton(type: "accept" | "reject", action: (e: MouseEvent) => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.name = type;
  button.textContent = type === "accept" ? "Accept" : "Reject";
  button.setAttribute(
    "aria-label",
    type === "accept" ? "Accept this change" : "Reject this change",
  );
  button.onclick = action;
  return button;
}

/** The position of the change at the cursor, else the next one, else the first; null: none left. */
function targetChange(state: EditorState): number | null {
  const chunks = getChunks(state)?.chunks ?? [];
  const head = state.selection.main.head;
  const at =
    chunks.find((c) => c.fromB <= head && head <= c.endB) ??
    chunks.find((c) => c.fromB >= head) ??
    chunks[0];
  return at === undefined ? null : at.fromB;
}

function openChanges(state: EditorState): number {
  return getChunks(state)?.chunks.length ?? 0;
}

function baseExtensions(label: string): Extension[] {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": label }),
    // CodeMirror (and @codemirror/merge) inject their styles as <style>; the nonce CSP drops
    // un-nonced ones, leaving the gutter above the text and the diff uncoloured (KOBE-469).
    EditorView.cspNonce.of(documentCspNonce()),
    theme,
  ];
}

function ReviewToolbar({ view }: { readonly view: EditorView | null }) {
  const act = (run: (view: EditorView, pos: number) => boolean) => {
    if (!view) return;
    const pos = targetChange(view.state);
    if (pos !== null) run(view, pos);
  };
  const actions: readonly (readonly [string, () => void])[] = [
    ["Previous change", () => view && goToPreviousChunk(view)],
    ["Next change", () => view && goToNextChunk(view)],
    ["Accept change", () => act(acceptChunk)],
    ["Reject change", () => act(rejectChunk)],
  ];
  return (
    <div role="toolbar" aria-label="Review changes" className="flex flex-wrap gap-1 px-1 pb-1">
      {actions.map(([name, onClick]) => (
        <button
          key={name}
          type="button"
          className="hover:bg-muted rounded border px-2 py-0.5 text-xs"
          onClick={onClick}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export default function CodeEditor({
  value,
  language,
  label,
  readOnly = false,
  original,
  onChange,
  onChunks,
  compact = false,
  onRun,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const callbacks = useRef({ onChange, onChunks, onRun });
  callbacks.current = { onChange, onChunks, onRun };
  const valueRef = useRef(value);
  valueRef.current = value;
  /** The last value the document was set from. */
  const synced = useRef(value);
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment() });

  // One view per file and per review; text, language and read-only change in place.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let chunks = -1;
    synced.current = valueRef.current;
    const report = (state: EditorState) => {
      if (original === undefined) return;
      const open = openChanges(state);
      if (open !== chunks) callbacks.current.onChunks?.((chunks = open));
    };
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          ...baseExtensions(label),
          Prec.highest(
            keymap.of([
              {
                key: "Shift-Enter",
                run: () => {
                  const run = callbacks.current.onRun;
                  if (!run) return false;
                  run();
                  return true;
                },
              },
            ]),
          ),
          compartments.current.language.of([]),
          compartments.current.readOnly.of([]),
          original === undefined
            ? []
            : unifiedMergeView({
                original,
                mergeControls: chunkButton,
                highlightChanges: true,
                gutter: true,
                syntaxHighlightDeletions: true,
              }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString());
            report(update.state);
          }),
        ],
      }),
    });
    report(created.state);
    setView(created);
    return () => {
      created.destroy();
      setView(null);
    };
  }, [label, original]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    void languageExtension(language).then((ext) => {
      if (live) view.dispatch({ effects: compartments.current.language.reconfigure(ext) });
    });
    return () => {
      live = false;
    };
  }, [view, language]);

  useEffect(() => {
    view?.dispatch({
      effects: compartments.current.readOnly.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    });
  }, [view, readOnly]);

  // A new value from outside (a reload, a discarded draft) replaces the document; the value the
  // member's own typing produced comes back equal and changes nothing.
  useEffect(() => {
    if (!view || value === synced.current) return;
    synced.current = value;
    if (view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [view, value]);

  return (
    <div className={compact ? "flex flex-col" : "flex min-h-0 flex-1 flex-col"}>
      {original !== undefined && <ReviewToolbar view={view} />}
      <div
        ref={host}
        data-kobe-code-editor
        className={
          compact
            ? "min-h-10 overflow-hidden rounded-md border"
            : "min-h-80 flex-1 overflow-hidden rounded-md border"
        }
      />
    </div>
  );
}
