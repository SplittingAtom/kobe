"use client";

import type { ReasoningMessagePartProps } from "@assistant-ui/react";
import { formatDuration } from "../../lib/chat/history";
import { ArrivingWords } from "./arriving-words";
import { Disclosure, useDisclosure } from "./detail";
import { useArriving } from "./use-arriving";

/** The first non-empty line, for the collapsed block. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

/** Pi records when a step ends, not when its thinking does: the time shown is the step's. */
const STEP_HINT = "How long the whole step took: thinking and what the agent wrote after it.";

function stepTime(timing: ReasoningMessagePartProps["timing"]): string | undefined {
  if (timing?.completedAt === undefined) return undefined;
  return `step ${formatDuration(timing.completedAt - timing.startedAt)}`;
}

/**
 * Reasoning (CE12, KOBE-208), rendered for assistant-ui's reasoning part: collapsed to its first
 * line and how long its step took (labelled as the step's); open, the whole text. While it streams its words arrive as
 * fading spans (KOBE-207).
 */
export function Reasoning({ text, status, timing }: ReasoningMessagePartProps) {
  const arriving = useArriving(status);
  const { open, setOpen } = useDisclosure();
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      className="text-muted-foreground my-1 -ms-2 text-sm"
      summary={
        <>
          <span className="shrink-0 font-medium">{arriving ? "Thinking…" : "Reasoning"}</span>
          {!arriving && stepTime(timing) && (
            <span className="shrink-0 tabular-nums" title={STEP_HINT}>
              {stepTime(timing)}
            </span>
          )}
          {!open && <span className="min-w-0 truncate">{firstLine(text)}</span>}
        </>
      }
    >
      <div data-kobe-arrive={arriving ? "running" : undefined}>
        <p className="border-border m-0 ms-2 mt-1 border-s-2 ps-3 whitespace-pre-wrap">
          <ArrivingWords text={text} />
        </p>
      </div>
    </Disclosure>
  );
}
