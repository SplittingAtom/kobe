"use client";

import { useAuiState } from "@assistant-ui/react";
import { HoverCard } from "radix-ui";
import { useCallback, useRef, useState, type ReactNode } from "react";
import type { ThreadCard } from "../../lib/chat/types";
import { useChatSession } from "../chat/kobe-runtime";
import { chatPortalContainer } from "../ui/chat-portal";
import styles from "./rail.module.css";

/** Hover delay before the card opens (a pointer passing over the rail opens nothing). */
const OPEN_DELAY_MS = 600;

type CardState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly card: ThreadCard }
  | { readonly kind: "failed" };

/** "3 min ago", "yesterday", or the date for anything older than a week. */
export function lastActivity(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const seconds = Math.round((at - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(0, "minute");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
  return new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function agentLabel(card: ThreadCard): string {
  if (card.agentName) return card.agentName;
  return card.agentId === null ? "No agent" : "An agent no longer available";
}

function CardBody({ state }: { readonly state: CardState }) {
  if (state.kind === "loading") return <p className={styles.cardMuted}>Loading…</p>;
  if (state.kind === "failed") {
    return <p className={styles.cardMuted}>The details could not be loaded.</p>;
  }
  const { card } = state;
  return (
    <>
      <p className={styles.cardMessage}>
        {card.firstMessage === null
          ? "No messages yet."
          : `${card.firstMessage}${card.firstMessageTruncated ? "…" : ""}`}
      </p>
      <dl className={styles.cardFacts}>
        <dt>Agent</dt>
        <dd>{agentLabel(card)}</dd>
        <dt>Last activity</dt>
        <dd>
          <time
            dateTime={card.lastActivityAt}
            title={new Date(card.lastActivityAt).toLocaleString()}
          >
            {lastActivity(card.lastActivityAt)}
          </time>
        </dd>
        <dt>Messages</dt>
        <dd>{card.messageCount}</dd>
      </dl>
    </>
  );
}

/**
 * The rail's hover card (CE18, KOBE-219) around a thread row's trigger: instead of a
 * model-written summary, the thread's first message (cut short), its agent, its last activity
 * and its message count, read from the server when the card opens (Radix HoverCard: pointer
 * hover or keyboard focus, after a short delay). Purely supplementary: the row works without it.
 */
export function RailThreadCard({ children }: { readonly children: ReactNode }) {
  const session = useChatSession();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const [state, setState] = useState<CardState>({ kind: "loading" });
  const reading = useRef(0);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open || remoteId === undefined) return;
      const n = ++reading.current;
      void session.api.threadCard(remoteId).then((res) => {
        if (n !== reading.current) return;
        if (res.ok) setState({ kind: "ready", card: res.data });
        else {
          console.warn("rail: could not read the thread's card", res.error);
          setState((prev) => (prev.kind === "ready" ? prev : { kind: "failed" }));
        }
      });
    },
    [session, remoteId],
  );

  if (remoteId === undefined) return <>{children}</>;
  return (
    <HoverCard.Root openDelay={OPEN_DELAY_MS} closeDelay={100} onOpenChange={onOpenChange}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal container={chatPortalContainer()}>
        <HoverCard.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className={styles.card}
          data-testid="thread-card"
        >
          <CardBody state={state} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
