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

function headline(running: boolean, timing: ReasoningMessagePartProps["timing"]): string {
  if (running) return "Thinking…";
  if (timing?.completedAt !== undefined) {
    return `Thought for ${formatDuration(timing.completedAt - timing.startedAt)}`;
  }
  return "Reasoning";
}

/**
 * Reasoning (CE12, KOBE-208), rendered for assistant-ui's reasoning part: collapsed to its first
 * line and how long the step took; open, the whole text. While it streams its words arrive as
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
          <span className="shrink-0 font-medium">{headline(arriving, timing)}</span>
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
