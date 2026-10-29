import { contrastRatio, type FloorFailure, type FloorReport } from "@kobe/protocol";

/**
 * The Appearance page's contrast wording (KOBE-501, TH4): the live line under a custom accent and
 * each failed floor rule (packages/protocol theme/accent.ts) in the admin's words. Ratios are cut,
 * never rounded up, so a 4.47:1 never reads as passing.
 */

const oneDecimal = (ratio: number): string => (Math.floor(ratio * 10) / 10).toFixed(1);
const fgName = (hex: string): string => (hex === "#ffffff" ? "white" : "near-black");

/** "Accent text: white, 7.2:1 light / 6.1:1 dark" (the colour named again when it differs). */
export function contrastLine({ derived }: FloorReport): string {
  const { primary, primaryFg } = derived;
  const light = contrastRatio(primaryFg.light, primary.light);
  const dark = contrastRatio(primaryFg.dark, primary.dark);
  const darkName = primaryFg.dark === primaryFg.light ? "" : `${fgName(primaryFg.dark)}, `;
  return `Accent text: ${fgName(primaryFg.light)}, ${oneDecimal(light)}:1 light / ${darkName}${oneDecimal(dark)}:1 dark`;
}

const SURFACES: Readonly<Record<string, string>> = {
  page: "the page",
  panel: "side panels",
  card: "cards",
};

function subject(rule: string): string {
  const [kind, surface] = rule.split(" on ");
  const where = surface === undefined ? "" : ` on ${SURFACES[surface] ?? surface}`;
  switch (kind) {
    case "primary_on_surface":
      return "The accent barely stands out from the background";
    case "fg_on_primary":
      return "Text on the accent is too faint";
    case "fg_on_hover":
      return "Text on the accent's hover shade is too faint";
    case "link":
      return `Links are too faint${where}`;
    case "focus":
      return `Focus outlines are too faint${where}`;
    default:
      return `${rule} fails`;
  }
}

export function failureText(f: FloorFailure): string {
  const scheme = f.scheme === "both" ? "both themes" : `the ${f.scheme} theme`;
  return `${subject(f.rule)} in ${scheme} (${f.ratio}:1; it needs ${f.required}:1).`;
}

/** Each failure once, in the floor's order. */
export function failureTexts(failures: readonly FloorFailure[]): string[] {
  return [...new Set(failures.map(failureText))];
}

/** Why Save is off for this accent, or null when it meets the floor. */
export function floorReason(report: FloorReport): string | null {
  const first = report.failures[0];
  if (report.ok || first === undefined) return null;
  return `Save is off until the accent meets the contrast floor: ${failureText(first)}`;
}
