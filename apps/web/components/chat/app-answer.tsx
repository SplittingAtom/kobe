"use client";

import { MessagePrimitive, useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ToolActivity } from "../../lib/chat/live";
import { Disclosure } from "./detail";
import { useKobeExtras } from "./kobe-runtime";
import { ApprovalMarkerRow } from "./markers";

/**
 * Answers with an MCP App (KOBE-608): the answer shows only its app card(s), as a rail-launched
 * app card does (KOBE-440); the rest (prose, reasoning, other tool cards, the skills used) sits
 * behind a collapsed "Show response" under them, in its original order. Approvals, problems and
 * blocked-egress cards always show. The parts render in passes:
 *
 * - `all`: an answer without an app, as before;
 * - `kept`: what an app answer always shows (its app cards, approvals, problems, markers);
 * - `rest`: the hidden parts, under the toggle once opened.
 */
export type AnswerPass =
  { readonly mode: "all" } | { readonly mode: "kept" | "rest"; readonly apps: ReadonlySet<string> };

const ALL: AnswerPass = { mode: "all" };
const PassContext = createContext<AnswerPass>(ALL);

/** A part that belongs to the answer's content: hidden in an app answer until "Show response". */
export function hiddenInAppAnswer<P extends object>(Part: (props: P) => ReactNode) {
  return function ContentPart(props: P) {
    return useContext(PassContext).mode === "kept" ? null : <Part {...props} />;
  };
}

/** A part an app answer always shows (approvals, problems, markers): never hidden. */
export function keptInAppAnswer<P extends object>(Part: (props: P) => ReactNode) {
  return function KeptPart(props: P) {
    return useContext(PassContext).mode === "rest" ? null : <Part {...props} />;
  };
}

const NO_ACTIVITY: Partial<ToolActivity> = {};

/** A tool call that needs the member, or blocked a domain, shows even in an app answer. */
function mustShow(activity: Partial<ToolActivity>): boolean {
  return activity.approvalRequested !== undefined || (activity.egressBlocked?.length ?? 0) > 0;
}

/**
 * A tool card in its pass: an app card or one that must show stays in the kept pass with its
 * approval row; any other card is hidden, its approval row (allowed, denied, expired) still shown.
 */
export function withAppAnswerPass(Card: (props: ToolCallMessagePartProps) => ReactNode) {
  return function ToolCallInPass(props: ToolCallMessagePartProps) {
    const pass = useContext(PassContext);
    const activity = useKobeExtras()?.state.live?.tools[props.toolCallId] ?? NO_ACTIVITY;
    const card = <Card {...props} />;
    const marker = <ApprovalMarkerRow toolCallId={props.toolCallId} />;
    if (pass.mode === "all") {
      return (
        <>
          {card}
          {marker}
        </>
      );
    }
    const kept = pass.apps.has(props.toolCallId) || mustShow(activity);
    if (pass.mode === "rest") return kept ? null : card;
    return (
      <>
        {kept && card}
        {marker}
      </>
    );
  };
}

/** Whether an app answer has anything for "Show response" to show. */
function useHasHidden(apps: ReadonlySet<string>, usedSkills: boolean): boolean {
  const hidden = useAuiState((s) =>
    s.message.content.some((part) => {
      if (part.type === "text") return part.text.trim() !== "";
      if (part.type === "reasoning") return true;
      if (part.type === "tool-call") return !apps.has(part.toolCallId);
      if (part.type === "data")
        return part.name === "kobe-offloaded" || part.name === "kobe-skipped";
      return false;
    }),
  );
  return hidden || usedSkills;
}

/**
 * An answer's parts in passes: `apps` null renders them as before; otherwise the app cards, then
 * "Show response" (aria-expanded) and, once opened, the rest in its original order.
 */
export function AppAnswerParts({
  apps,
  parts,
  skills,
  hasSkills,
}: {
  readonly apps: ReadonlySet<string> | null;
  readonly parts: ComponentProps<typeof MessagePrimitive.Parts>["components"];
  /** The answer's "Used skill" line, hidden with the rest. */
  readonly skills: ReactNode;
  readonly hasSkills: boolean;
}) {
  if (apps === null) {
    return (
      <PassContext.Provider value={ALL}>
        <MessagePrimitive.Parts components={parts} />
        {skills}
      </PassContext.Provider>
    );
  }
  return <AppOnly apps={apps} parts={parts} skills={skills} hasSkills={hasSkills} />;
}

function AppOnly({
  apps,
  parts,
  skills,
  hasSkills,
}: {
  readonly apps: ReadonlySet<string>;
  readonly parts: ComponentProps<typeof MessagePrimitive.Parts>["components"];
  readonly skills: ReactNode;
  readonly hasSkills: boolean;
}) {
  const [open, setOpen] = useState(false);
  const kept = useMemo<AnswerPass>(() => ({ mode: "kept", apps }), [apps]);
  const rest = useMemo<AnswerPass>(() => ({ mode: "rest", apps }), [apps]);
  const hasHidden = useHasHidden(apps, hasSkills);
  return (
    <>
      <PassContext.Provider value={kept}>
        <MessagePrimitive.Parts components={parts} />
      </PassContext.Provider>
      {hasHidden && (
        <Disclosure
          open={open}
          onOpenChange={setOpen}
          className="text-muted-foreground -ms-2 text-sm"
          bodyClassName="text-foreground flex flex-col gap-2 ps-2 pt-2"
          summary={<span data-kobe-show-response>Show response</span>}
        >
          {open && (
            <PassContext.Provider value={rest}>
              <MessagePrimitive.Parts components={parts} />
              {skills}
            </PassContext.Provider>
          )}
        </Disclosure>
      )}
    </>
  );
}
