"use client";

import { useEffect, useState } from "react";
import { modelName, type TeamModels } from "../../lib/admin/api/team/models";
import { formatTokens } from "../../lib/admin/usage-format";
import {
  contextPercent,
  gaugeLabel,
  gaugeLevel,
  newestContextTokens,
  type GaugeReading,
} from "../../lib/chat/context-usage";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import { useThreadUsageRead } from "../chat/message-footer";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { IconAction } from "./icon-action";
import styles from "./context-gauge.module.css";

const NAME = "Context used";

export interface ContextGaugeProps extends GaugeReading {
  /** Compact now (CE15, B9 KOBE-213), offered at red; absent: not offered (until B9 lands). */
  readonly onCompact?: (() => void) | undefined;
}

/**
 * How full the thread's context is (CE14, KOBE-211): a short bar, green below 65%, orange from
 * 65%, red from 85%, with "142k of 200k tokens (71%) · <model>" as its tooltip and value text.
 * Without a context window it shows the token count only. Content, so text and a meter rather
 * than an IconAction; it shares IconAction's tooltip provider and delay.
 */
export function ContextGauge({ tokens, window, model, onCompact }: ContextGaugeProps) {
  const label = gaugeLabel({ tokens, window, model });
  const used = tokens ?? 0;
  const percent = window === null ? 0 : contextPercent(used, window);
  const level = gaugeLevel(percent);
  const offerCompact = window !== null && level === "full" && onCompact !== undefined;
  const face =
    window === null ? (
      <span className={styles.tokens} tabIndex={0} data-context-gauge>
        <span className="sr-only">{NAME}: </span>
        {formatTokens(used)} tokens
      </span>
    ) : (
      <div
        role="meter"
        aria-label={NAME}
        aria-valuemin={0}
        aria-valuemax={window}
        aria-valuenow={Math.min(used, window)}
        aria-valuetext={label}
        data-level={level}
        data-context-gauge
        tabIndex={0}
        className={styles.meter}
      >
        <span className={styles.fill} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
    );
  return (
    <span className={styles.gauge}>
      <Tooltip>
        <TooltipTrigger asChild>{face}</TooltipTrigger>
        <TooltipContent side="bottom">
          {label}
          {offerCompact && <span className={styles.tooltipLine}>Compact this thread</span>}
        </TooltipContent>
      </Tooltip>
      {offerCompact && <IconAction command="compact-thread" size="sm" onClick={onCompact} />}
    </span>
  );
}

/** The team's catalog, for the thread model's window and name (cached by the session). */
function useTeamModels(threadId: string | null): TeamModels | null {
  const session = useChatSession();
  const [models, setModels] = useState<TeamModels | null>(null);
  useEffect(() => {
    if (threadId === null) return;
    let current = true;
    session.models().then(
      (res) => {
        if (current) setModels(res.ok ? res.data : null);
      },
      () => {
        if (current) setModels(null);
      },
    );
    return () => {
      current = false;
    };
  }, [session, threadId]);
  return models;
}

/**
 * The open thread's gauge (bar row two). The value is the newest model call's input: run_usage on
 * load and after each run, each streamed assistant message during one. The scale is the model the
 * thread runs with next (the agent's pin, the thread's choice, else the team default), so a model
 * change re-scales the same fill. A new conversation shows none until it exists.
 */
export function ThreadContextGauge() {
  const extras = useKobeExtras();
  const threadId = extras?.state.threadId ?? null;
  const models = useTeamModels(threadId);
  const read = useThreadUsageRead();
  if (!extras || threadId === null || extras.state.phase !== "ready") return null;
  const { state } = extras;
  const alias = state.agentModel ?? state.summary?.model ?? models?.default ?? null;
  const entry = models?.models.find((m) => m.alias === alias);
  const tokens = newestContextTokens(
    state.live,
    read && { afterRun: read.afterRun, latestCall: read.usage.latestCall },
  );
  return (
    <ContextGauge
      tokens={tokens}
      window={entry?.contextWindow ?? null}
      model={entry ? modelName(entry) : alias}
    />
  );
}
