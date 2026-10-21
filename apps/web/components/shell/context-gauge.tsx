"use client";

import type { KeyboardEvent } from "react";
import { modelName, type TeamModel } from "../../lib/admin/api/team/models";
import { formatTokens } from "../../lib/admin/usage-format";
import {
  compactedSinceLastCall,
  contextPercent,
  gaugeLabel,
  gaugeLevel,
  newestContextSize,
  type ContextSize,
  type GaugeReading,
} from "../../lib/chat/context-usage";
import { initialThreadState } from "../../lib/chat/thread-state";
import { useKobeExtras } from "../chat/kobe-runtime";
import { useThreadUsageRead } from "../chat/message-footer";
import { useThreadTeamModels } from "../chat/use-team-models";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useOpenContextViewer } from "./context-viewer";
import { IconAction } from "./icon-action";
import styles from "./context-gauge.module.css";

const NAME = "Context used";
const DRAFT = initialThreadState(null);

export interface ContextGaugeProps extends GaugeReading {
  /** Compact now (CE15, B9 KOBE-213), offered at red; absent: not offered (a reader's thread). */
  readonly onCompact?: (() => void) | undefined;
  /** Why Compact now is unavailable right now (a run is on): offered, but disabled. */
  readonly compactBlocker?: string | null | undefined;
  /** Opens the context viewer (KOBE-471); absent: not offered (a reader's thread). */
  readonly onOpenContext?: (() => void) | undefined;
}

/** Enter or Space on the gauge opens the viewer, as a click does. */
function openProps(open: (() => void) | undefined) {
  if (open === undefined) return {};
  return {
    "aria-haspopup": "dialog" as const,
    "data-context-open": "",
    onClick: open,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      open();
    },
  };
}

/**
 * How full the thread's context is (CE14, KOBE-211): a short bar, green below 65%, orange from
 * 65%, red from 85%, with "142k of 200k tokens (71%) · <model>" as its tooltip and value text
 * ("· counted by <model>" when another model counted them). Without a context window it shows the
 * token count only. Content, so text and a meter rather
 * than an IconAction; it shares IconAction's tooltip provider and delay.
 */
export function ContextGauge({
  tokens,
  window,
  model,
  countedBy,
  onCompact,
  compactBlocker,
  onOpenContext,
}: ContextGaugeProps) {
  const label = gaugeLabel({ tokens, window, model, countedBy });
  const used = tokens;
  const percent = window === null ? 0 : contextPercent(used, window);
  const level = gaugeLevel(percent);
  const offerCompact = window !== null && level === "full" && onCompact !== undefined;
  const open = openProps(onOpenContext);
  const face =
    window === null ? (
      <span className={styles.tokens} tabIndex={0} data-context-gauge {...open}>
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
        {...open}
      >
        <span className={styles.fill} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
    );
  return (
    <span className={styles.gauge}>
      <Tooltip>
        <TooltipTrigger asChild>{face}</TooltipTrigger>
        <TooltipContent side="top">
          {label}
          {onOpenContext !== undefined && (
            <span className={styles.tooltipLine}>Click to see the context</span>
          )}
          {offerCompact && <span className={styles.tooltipLine}>Compact this thread</span>}
        </TooltipContent>
      </Tooltip>
      {offerCompact && (
        <IconAction
          command="compact-thread"
          size="sm"
          aria-disabled={compactBlocker != null}
          description={compactBlocker ?? undefined}
          onClick={compactBlocker == null ? onCompact : undefined}
        />
      )}
    </span>
  );
}

/** The catalog entry that counted the tokens: by alias (streamed) or gateway model (run_usage). */
function counterOf(models: readonly TeamModel[], size: ContextSize): TeamModel | string | null {
  const c = size.counter;
  if (c === null) return null;
  const found =
    "alias" in c
      ? models.find((m) => m.alias === c.alias)
      : models.find((m) => m.gatewayModel === c.gatewayModel);
  return found ?? ("alias" in c ? c.alias : c.gatewayModel);
}

/**
 * The open thread's gauge, at the end of the row under the composer (KOBE-418). The value is the
 * newest model call's prompt: run_usage on load and after each run, each streamed assistant
 * message during one; unknown (no gauge) before the first call and after a compaction until the
 * next. The scale is the model the thread runs
 * with next (the agent's pin, the thread's choice, else the team default), so a model change
 * re-scales the same fill; when another model counted the tokens, the text says which.
 */
export function ThreadContextGauge({
  onCompact,
  compactBlocker,
}: Pick<ContextGaugeProps, "onCompact" | "compactBlocker"> = {}) {
  const extras = useKobeExtras();
  const state = extras?.state ?? DRAFT;
  const loaded = useThreadTeamModels();
  const read = useThreadUsageRead();
  const openViewer = useOpenContextViewer();
  if (!extras || state.threadId === null || state.phase !== "ready") return null;
  const size = newestContextSize(
    state.live,
    read && { afterRun: read.afterRun, latestCall: read.usage.latestCall },
    compactedSinceLastCall(state.entries),
  );
  const models = loaded.status === "ready" ? loaded.data.models : [];
  const teamDefault = loaded.status === "ready" ? loaded.data.default : null;
  const alias = state.agentModel ?? state.summary?.model ?? teamDefault;
  const scale = models.find((m) => m.alias === alias);
  const window = scale?.contextWindow ?? null;
  if (size === null) return null;
  // Owner only (CV2, KOBE-471): a shared reader's gauge offers nothing.
  const owner = openViewer !== null && state.summary?.readOnly !== true;
  const counter = counterOf(models, size);
  const counterIsScale =
    counter === null || (typeof counter === "string" ? counter === alias : counter === scale);
  const name = (m: TeamModel | string) => (typeof m === "string" ? m : modelName(m));
  return (
    <ContextGauge
      tokens={size.tokens}
      window={window}
      model={scale ? modelName(scale) : alias}
      countedBy={counterIsScale ? null : name(counter)}
      onCompact={onCompact}
      compactBlocker={compactBlocker}
      onOpenContext={owner ? () => openViewer(window) : undefined}
    />
  );
}
