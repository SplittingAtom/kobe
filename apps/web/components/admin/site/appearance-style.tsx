"use client";

import {
  ACCENT_PATTERN,
  CORNER_STYLES,
  DEFAULT_ACCENT,
  FONT_STACKS,
  PRESET_IDS,
  PRESET_LABELS,
  checkFloor,
  deriveAccent,
  type CornerStyle,
  type FloorReport,
  type FontStack,
  type PresetId,
  type ThemeSettings,
} from "@kobe/protocol";
import { PRESETS } from "../../../lib/theme/presets";
import { ChoiceGroup, Field, FOCUS_RING, Radio, TextInput } from "../../ui/console";
import { contrastLine, failureTexts } from "./appearance-contrast";

/**
 * The style (KOBE-501, TH2/TH9-TH11): one of the six presets, or Custom (an accent, corners and
 * a typeface). The accent's floor (TH4) is measured live with the server's own checkFloor().
 */

export interface StyleDraft {
  readonly preset: PresetId | "custom";
  /** The hex field as typed; only a full `#rrggbb` makes a theme. */
  readonly accentText: string;
  readonly corners: CornerStyle;
  readonly font: FontStack;
}

const CORNER_LABELS: Readonly<Record<CornerStyle, string>> = {
  sharp: "Sharp",
  soft: "Soft",
  round: "Round",
};
const FONT_LABELS: Readonly<Record<FontStack, string>> = {
  system: "System",
  humanist: "Humanist",
  grotesk: "Grotesk",
  serif: "Serif",
};

function presetAccent(id: PresetId): string {
  const value = PRESETS[id].light["--kobe-brand-primary"];
  return ACCENT_PATTERN.test(value) ? value : DEFAULT_ACCENT;
}

/** A preset's look as the starting point of Custom. */
const fromPreset = (id: PresetId): StyleDraft => ({
  preset: id,
  accentText: presetAccent(id),
  corners: PRESETS[id].corners,
  font: PRESETS[id].font,
});

export function draftOf(theme: ThemeSettings): StyleDraft {
  if (theme.preset !== "custom") return fromPreset(theme.preset);
  return { preset: "custom", accentText: theme.accent, corners: theme.corners, font: theme.font };
}

const normalHex = (text: string): string => text.trim().toLowerCase();

/** The theme the draft stands for; null while the hex is not a full `#rrggbb`. */
export function themeOf(draft: StyleDraft): ThemeSettings | null {
  if (draft.preset !== "custom") return { preset: draft.preset };
  const accent = normalHex(draft.accentText);
  if (!ACCENT_PATTERN.test(accent)) return null;
  return { preset: "custom", accent, corners: draft.corners, font: draft.font };
}

const SWATCH_TOKENS = [
  "--kobe-console-bg",
  "--kobe-console-panel",
  "--kobe-brand-primary",
  "--kobe-console-fg",
] as const;

/** Page, panel, accent and text of one scheme, as an SVG strip (fill attributes, no styles). */
function Strip({ colours }: { readonly colours: readonly string[] }) {
  return (
    <svg width={64} height={14} viewBox="0 0 64 14" aria-hidden="true" className="block rounded-sm">
      {colours.map((fill, i) => (
        <rect key={i} x={i * 16} y={0} width={16} height={14} fill={fill} />
      ))}
    </svg>
  );
}

function swatchColours(id: PresetId | "custom", accent: string | null, scheme: "light" | "dark") {
  if (id !== "custom") return SWATCH_TOKENS.map((t) => PRESETS[id][scheme][t]);
  const base = PRESETS.default[scheme];
  const primary =
    accent === null ? base["--kobe-brand-primary"] : deriveAccent(accent).primary[scheme];
  return SWATCH_TOKENS.map((t) => (t === "--kobe-brand-primary" ? primary : base[t]));
}

function StyleCard({
  id,
  label,
  checked,
  accent,
  onPick,
}: {
  readonly id: PresetId | "custom";
  readonly label: string;
  readonly checked: boolean;
  readonly accent: string | null;
  readonly onPick: () => void;
}) {
  return (
    <label className="box-border flex cursor-pointer flex-col gap-2 rounded-lg border border-console-border bg-console-bg p-3 has-checked:border-brand-primary has-checked:outline-2 has-checked:outline-brand-primary">
      <span className="inline-flex items-center gap-2 font-medium">
        <input
          type="radio"
          name="appearance-style"
          value={id}
          checked={checked}
          onChange={onPick}
          className={`m-0 size-4 accent-console-accent ${FOCUS_RING}`}
        />
        {label}
      </span>
      <span className="flex flex-col gap-1" aria-hidden="true">
        <Strip colours={swatchColours(id, accent, "light")} />
        <Strip colours={swatchColours(id, accent, "dark")} />
      </span>
    </label>
  );
}

function ContrastReport({ report }: { readonly report: FloorReport }) {
  return (
    <div aria-live="polite" className="mt-3">
      <p className="m-0 text-sm">{contrastLine(report)}</p>
      {!report.ok && (
        <ul className="m-0 mt-1 ps-5 text-sm font-medium text-console-danger">
          {failureTexts(report.failures).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CustomFields({
  draft,
  onDraft,
  report,
}: {
  readonly draft: StyleDraft;
  readonly onDraft: (next: StyleDraft) => void;
  readonly report: FloorReport | null;
}) {
  const hex = normalHex(draft.accentText);
  const valid = ACCENT_PATTERN.test(hex);
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Accent colour"
          hint="Buttons, links, focus outlines and count badges. Neutrals keep the default look."
          error={valid ? null : "Enter the colour as #rrggbb, for example #2449c7."}
        >
          <TextInput
            className="w-32 font-mono"
            value={draft.accentText}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onDraft({ ...draft, accentText: e.target.value })}
          />
        </Field>
        <input
          type="color"
          aria-label="Pick the accent colour"
          value={valid ? hex : DEFAULT_ACCENT}
          onChange={(e) => onDraft({ ...draft, accentText: e.target.value })}
          className={`m-0 box-border h-8 w-12 cursor-pointer rounded-md border border-console-control bg-console-bg p-0.5 ${FOCUS_RING}`}
        />
      </div>
      {report !== null && <ContrastReport report={report} />}
      <ChoiceGroup legend="Corners">
        {CORNER_STYLES.map((c) => (
          <Radio
            key={c}
            name="appearance-corners"
            label={CORNER_LABELS[c]}
            checked={draft.corners === c}
            onChange={() => onDraft({ ...draft, corners: c })}
          />
        ))}
      </ChoiceGroup>
      <ChoiceGroup legend="Typeface" hint="System font stacks: nothing is downloaded.">
        {FONT_STACKS.map((f) => (
          <Radio
            key={f}
            name="appearance-font"
            label={FONT_LABELS[f]}
            checked={draft.font === f}
            onChange={() => onDraft({ ...draft, font: f })}
          />
        ))}
      </ChoiceGroup>
    </div>
  );
}

/** The contrast floor of the draft's custom accent; null for a preset or an incomplete hex. */
export function floorOf(theme: ThemeSettings | null): FloorReport | null {
  return theme?.preset === "custom" ? checkFloor(theme) : null;
}

export function StylePicker({
  draft,
  onDraft,
  report,
}: {
  readonly draft: StyleDraft;
  readonly onDraft: (next: StyleDraft) => void;
  /** {@link floorOf} the draft, computed once by the page (it also gates Save). */
  readonly report: FloorReport | null;
}) {
  const theme = themeOf(draft);
  const accent = theme?.preset === "custom" ? theme.accent : null;
  return (
    <>
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 p-0 font-medium">Style</legend>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
          {PRESET_IDS.map((id) => (
            <StyleCard
              key={id}
              id={id}
              label={PRESET_LABELS[id]}
              checked={draft.preset === id}
              accent={null}
              onPick={() => onDraft(fromPreset(id))}
            />
          ))}
          <StyleCard
            id="custom"
            label="Custom"
            checked={draft.preset === "custom"}
            accent={accent}
            onPick={() => onDraft({ ...draft, preset: "custom" })}
          />
        </div>
      </fieldset>
      {draft.preset === "custom" && (
        <CustomFields draft={draft} onDraft={onDraft} report={report} />
      )}
    </>
  );
}
