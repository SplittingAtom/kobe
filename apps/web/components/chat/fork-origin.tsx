"use client";

import { GitForkIcon } from "lucide-react";
import { HIDDEN_SOURCE, forkOrigin, forkPointExcerpt, sourceName } from "../../lib/chat/fork";
import { InlineLink } from "../shell/text-links";
import type { KobeThreadExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

/**
 * The fork's origin above its conversation (CE16, KOBE-216): "Forked from <thread> at <message>".
 * The source links back only when the server named it (the viewer may open it); otherwise the
 * text stays neutral. The message is the fork's own copy of the fork point. Plain text only.
 */
export function ForkOriginNote({
  extras,
  onOpenThread,
}: {
  readonly extras: KobeThreadExtras;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const origin = forkOrigin(extras.state.summary);
  if (origin === null) return null;
  const excerpt = forkPointExcerpt(extras.projection, origin.at);
  const name = sourceName(origin);
  return (
    <p className={styles.forkOrigin} role="note" aria-label="Fork origin">
      <GitForkIcon aria-hidden className="size-3.5 shrink-0" />
      <span>
        Forked from{" "}
        {origin.kind === "source" ? (
          <InlineLink
            href={`/?thread=${origin.threadId}`}
            onClick={(e) => {
              if (!onOpenThread) return;
              e.preventDefault();
              onOpenThread(origin.threadId);
            }}
          >
            {name}
          </InlineLink>
        ) : (
          HIDDEN_SOURCE
        )}
        {excerpt !== null && <> at “{excerpt}”</>}
      </span>
    </p>
  );
}
