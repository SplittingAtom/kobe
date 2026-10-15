"use client";

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
import { IconAction } from "./icon-action";
import styles from "./context-gauge.module.css";

const NAME = "Context used";
const DRAFT = initialThreadState(null);

export interface ContextGaugeProps extends GaugeReading {
  /** Compact now (CE15, B9 KOBE-213), offered at red; absent: not offered (a reader's thread). */
  readonly onCompact?: (() => void) | undefined;
  /** Why Compact now is unavailable right now (a run is on): offered, but disabled. */
  readonly compactBlocker?: string | null | undefined;
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
}: ContextGaugeProps) {
  const label = gaugeLabel({ tokens, window, model, countedBy });
  const used = tokens;
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
 * The open thread's gauge (bar row two). The value is the newest model call's prompt: run_usage on
 * load and after each run, each streamed assistant message during one; unknown (no gauge) before
 * the first call and after a compaction until the next. The scale is the model the thread runs
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
  if (!extras || state.threadId === null || state.phase !== "ready") return null;
  const size = newestContextSize(
    state.live,
    read && { afterRun: read.afterRun, latestCall: read.usage.latestCall },
    compactedSinceLastCall(state.entries),
  );
  if (size === null) return null;
  const models = loaded.status === "ready" ? loaded.data.models : [];
  const teamDefault = loaded.status === "ready" ? loaded.data.default : null;
  const alias = state.agentModel ?? state.summary?.model ?? teamDefault;
  const scale = models.find((m) => m.alias === alias);
  const counter = counterOf(models, size);
  const counterIsScale =
    counter === null || (typeof counter === "string" ? counter === alias : counter === scale);
  const name = (m: TeamModel | string) => (typeof m === "string" ? m : modelName(m));
  return (
    <ContextGauge
      tokens={size.tokens}
      window={scale?.contextWindow ?? null}
      model={scale ? modelName(scale) : alias}
      countedBy={counterIsScale ? null : name(counter)}
      onCompact={onCompact}
      compactBlocker={compactBlocker}
    />
  );
}
