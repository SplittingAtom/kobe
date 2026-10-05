/** Orbit score wording shared by the consoles (KOBE-94). Rates arrive as 0 to 1. */
export const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;

/** "12% (passed)", "Evaluating…", "Errored", "—": one line for a table cell. */
export function scoreLabel(score: {
  readonly status: "none" | "evaluating" | "passed" | "blocked" | "errored";
  readonly attackSuccessRate: number | null;
}): string {
  switch (score.status) {
    case "none":
      return "—";
    case "evaluating":
      return "Evaluating…";
    case "errored":
      return "Errored";
    case "passed":
    case "blocked":
      return score.attackSuccessRate === null
        ? score.status
        : `${percent(score.attackSuccessRate)} (${score.status})`;
  }
}
