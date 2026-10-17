"use client";

import { THINKING_LEVELS, lowestThinking, thinkingRank, type ThinkingLevel } from "@kobe/protocol";
import { modelName, type TeamModel } from "../../../lib/admin/api/team/models";
import { Select } from "../../ui/console";
import { THINKING_LEVEL_LABELS } from "../site/model-thinking";

/**
 * A team's thinking maximum for one model (KOBE-260): it can only lower the site's (the list
 * stops at the site's maximum), `Off` turns thinking off for the team where the model allows it.
 * Models without a thinking control, or with thinking off on the site, show what applies.
 */
const SITE = "site";

export function TeamThinkingCell({
  model: m,
  disabled,
  onChange,
}: {
  readonly model: TeamModel;
  readonly disabled: boolean;
  readonly onChange: (max: ThinkingLevel | null) => void;
}) {
  const site = m.thinking;
  if (site === undefined || site.control === "none") {
    return <span className="text-sm text-console-muted">Not controlled</span>;
  }
  if (!site.allowed || site.max === null) {
    return <span className="text-sm text-console-muted">Off (site setting)</span>;
  }
  const siteMax = site.max;
  const lowest = lowestThinking(site.control);
  const levels = THINKING_LEVELS.filter(
    (l) => thinkingRank(l) >= thinkingRank(lowest) && thinkingRank(l) < thinkingRank(siteMax),
  );
  return (
    <Select
      aria-label={`Highest thinking level for ${modelName(m)}`}
      value={m.thinkingMax ?? SITE}
      disabled={disabled || !m.enabled}
      onChange={(e) => onChange(e.target.value === SITE ? null : (e.target.value as ThinkingLevel))}
    >
      <option value={SITE}>Site maximum ({THINKING_LEVEL_LABELS[siteMax]})</option>
      {levels.map((l) => (
        <option key={l} value={l}>
          {l === "off" ? "Off for the team" : `Up to ${THINKING_LEVEL_LABELS[l].toLowerCase()}`}
        </option>
      ))}
    </Select>
  );
}
