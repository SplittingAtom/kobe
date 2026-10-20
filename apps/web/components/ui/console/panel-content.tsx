"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useConfirm } from "./confirm-dialog";
import { EmbeddedPage, InPanel } from "./embedded-context";

type Report = (id: string, dirty: boolean) => void;

const UnsavedContext = createContext<Report | null>(null);

/**
 * A page in a panel over the workspace with edits that closing would lose (KOBE-452): while
 * `dirty`, the panel asks before it closes. Forms need nothing: an edit in a `<form>` counts until
 * it is submitted. Outside a panel this does nothing.
 */
export function useUnsavedChanges(dirty: boolean): void {
  const report = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    report?.(id, dirty);
    return () => report?.(id, false);
  }, [report, id, dirty]);
}

/** A field edit counts unless it is a search or filter box (those lose nothing). */
function editedForm(target: EventTarget): HTMLFormElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLInputElement && target.type === "search") return null;
  const form = target.closest("form");
  return form && form.getAttribute("role") !== "search" ? form : null;
}

/** Asked before the panel closes: resolves true when it may (nothing unsaved, or discarded). */
export type PanelCloseGuard = () => Promise<boolean>;

/**
 * The page inside a panel over the workspace (KOBE-452; the frame is
 * components/shell/workspace-panel.tsx): the console and My area shells render in panel mode
 * (`InPanel`), a single page leaves its title to the panel (`embedded`), and edits not saved yet
 * (form fields, `useUnsavedChanges`) make `guard` ask before the panel closes. Another page inside
 * the panel (`path`) starts the form tracking over: the last page's edits went with it.
 */
export function PanelContent({
  title,
  path,
  embedded,
  guard,
  children,
}: {
  readonly title: string;
  readonly path: string;
  readonly embedded: boolean;
  readonly guard: RefObject<PanelCloseGuard | null>;
  readonly children: ReactNode;
}) {
  const forms = useRef(new Set<HTMLFormElement>());
  const pages = useRef(new Set<string>());
  const [confirm, confirmDialog] = useConfirm();
  useEffect(() => {
    forms.current.clear();
  }, [path]);
  const report = useCallback<Report>((id, dirty) => {
    if (dirty) pages.current.add(id);
    else pages.current.delete(id);
  }, []);
  useEffect(() => {
    guard.current = async () => {
      const unsaved = pages.current.size > 0 || [...forms.current].some((form) => form.isConnected);
      if (!unsaved) return true;
      return confirm({
        title: "Discard your changes?",
        description: `Your edits in ${title} are not saved yet.`,
        confirmLabel: "Discard and close",
        cancelLabel: "Keep editing",
      });
    };
    return () => {
      guard.current = null;
    };
  }, [guard, confirm, title]);
  const onEdit = (e: FormEvent) => {
    const form = editedForm(e.target);
    if (form) forms.current.add(form);
  };
  const onSubmit = (e: FormEvent) => {
    if (e.target instanceof HTMLFormElement) forms.current.delete(e.target);
  };
  return (
    <div
      className="contents"
      onInputCapture={onEdit}
      onChangeCapture={onEdit}
      onSubmitCapture={onSubmit}
    >
      <UnsavedContext.Provider value={report}>
        <InPanel.Provider value={true}>
          <EmbeddedPage.Provider value={embedded}>{children}</EmbeddedPage.Provider>
        </InPanel.Provider>
      </UnsavedContext.Provider>
      {confirmDialog}
    </div>
  );
}
