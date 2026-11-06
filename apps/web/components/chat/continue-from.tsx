"use client";

import { useAuiState } from "@assistant-ui/react";
import { XIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { chipExcerpt, laterOnScreen } from "../../lib/chat/tree-panel";
import { messageMeta } from "../../lib/chat/tree";
import { IconAction } from "../shell/icon-action";
import { useKobeExtras, type KobeThreadExtras } from "./kobe-runtime";

/** Messages dimmed in place while Continue from here waits for the send (CT8). */
const DimmedContext = createContext<ReadonlySet<string>>(new Set());

export function ContinueProvider({
  extras,
  children,
}: {
  readonly extras: KobeThreadExtras;
  readonly children: ReactNode;
}) {
  const { projection, state } = extras;
  const dimmed = useMemo(
    () => laterOnScreen(projection, state.continueFrom),
    [projection, state.continueFrom],
  );
  return <DimmedContext.Provider value={dimmed}>{children}</DimmedContext.Provider>;
}

/** This message (in assistant-ui's message scope) is after the Continue from here answer. */
export function useDimmed(): boolean {
  const id = useAuiState((s) => s.message.id);
  return useContext(DimmedContext).has(id);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : ""))
    .join(" ");
}

/**
 * The composer's branch chip (CT8): "Continuing from the answer at “…” ⑂ · ✕". It takes the
 * focus to the composer when it comes up; ✕ (or Escape in the composer) drops it.
 */
export function ContinueChip({ extras }: { readonly extras: KobeThreadExtras }) {
  const { state, projection, controller } = extras;
  const from = state.continueFrom;
  const node = from === undefined ? undefined : projection.nodeOfEntry.get(from);
  const item = node === undefined ? undefined : projection.items.find((i) => i.message.id === node);
  useEffect(() => {
    if (from === undefined) return;
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>("[data-kobe-composer] textarea")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [from]);
  if (from === undefined) return null;
  const excerpt = chipExcerpt(textOf(item?.message.content));
  return (
    <div className="px-2">
      <span
        data-kobe-continue-chip={from}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
      >
        <span className="truncate">
          Continuing from the answer at “{excerpt}” <span aria-hidden>⑂</span>
        </span>
        <span aria-hidden>·</span>
        <button
          type="button"
          aria-label="Stop continuing from that answer"
          className="rounded-full p-0"
          onClick={() => controller?.clearContinue()}
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </span>
    </div>
  );
}

/**
 * The answer's hover action (CT8): on any committed answer that is not live and not the leaf's
 * own last answer; the owner's only (a reader cannot send).
 */
export function ContinueAction() {
  const extras = useKobeExtras();
  const id = useAuiState((s) => s.message.id);
  const meta = useAuiState((s) => messageMeta(s.message));
  if (!extras?.controller || extras.state.summary?.readOnly === true) return null;
  if (extras.state.summary?.deletedAt != null) return null;
  if (meta?.kind !== "assistant" || meta.live || meta.appCard === true) return null;
  const leaf = extras.state.summary?.leafEntryId ?? null;
  if (leaf !== null && extras.projection.nodeOfEntry.get(leaf) === id) return null;
  const last = extras.projection.lastEntryOfNode.get(id);
  if (last === undefined) return null;
  const { controller } = extras;
  return (
    <IconAction
      command="continue-from-here"
      size="sm"
      onClick={() => controller.continueFrom(last)}
    />
  );
}
