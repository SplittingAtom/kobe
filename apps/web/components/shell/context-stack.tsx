"use client";

import type { CSSProperties } from "react";
import { formatTokens } from "../../lib/admin/usage-format";
import { GAUGE_LABELS, formatShare, type GaugeModel } from "../../lib/chat/context-viewer";
import styles from "./context-viewer.module.css";

const share = (part: number): CSSProperties => ({ "--share": `${part * 100}%` }) as CSSProperties;

/**
 * The context viewer's gauge (KOBE-471): the context window as a vertical bar filled from the
 * bottom, stacked by kind in the order the model saw them, free space on top (a horizontal bar
 * at phone width). Each kind has its own colour and pattern, so colour never tells them apart
 * alone, and the legend names each with its tokens and share of the window. A segment or a legend
 * row shows that kind's first section in the text; the legend is the keyboard's way, so the
 * segments stay out of the tab order.
 */
export function ContextStack({
  model,
  onPick,
}: {
  readonly model: GaugeModel;
  readonly onPick: (section: number) => void;
}) {
  const { window, free } = model;
  return (
    <div className={styles.stack}>
      <div className={styles.bar} aria-hidden="true">
        {model.slices.map((s) => (
          <button
            key={s.kind}
            type="button"
            tabIndex={-1}
            data-context-segment={s.kind}
            data-kind={s.kind}
            className={styles.segment}
            style={share(s.share)}
            title={`${GAUGE_LABELS[s.kind]}: ${formatTokens(s.tokens)} tokens`}
            onClick={() => onPick(s.firstSection)}
          />
        ))}
        {model.freeShare > 0 && <span className={styles.free} />}
      </div>
      <ul className={styles.legend} aria-label="Context by kind">
        {model.slices.map((s) => (
          <li key={s.kind}>
            <button
              type="button"
              className={styles.legendRow}
              data-context-legend={s.kind}
              aria-label={`${GAUGE_LABELS[s.kind]}: ${formatTokens(s.tokens)} tokens, ${formatShare(s.ofWindow)}. Show in the text`}
              onClick={() => onPick(s.firstSection)}
            >
              <span className={styles.swatch} data-kind={s.kind} />
              <span className={styles.legendName}>{GAUGE_LABELS[s.kind]}</span>
              <span className={styles.legendTokens}>{formatTokens(s.tokens)} tokens</span>
              <span className={styles.legendShare}>{formatShare(s.ofWindow)}</span>
            </button>
          </li>
        ))}
        {window !== null && (
          <li className={styles.legendRow}>
            <span className={styles.swatch} data-kind="free" />
            <span className={styles.legendName}>Free</span>
            <span className={styles.legendTokens}>{formatTokens(free)} tokens</span>
            <span className={styles.legendShare}>{formatShare(free / window)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
