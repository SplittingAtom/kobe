/**
 * Console output shared by the license CLIs. Pending license decisions are warnings (GitHub
 * annotations in Actions) so they never block a push; `--gate` (or LICENSE_GATE=1) turns them
 * into failures for gate reviews.
 */
export const GATE = process.argv.includes("--gate") || process.env.LICENSE_GATE === "1";

export function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

export function warnPending(items: readonly string[]): void {
  const actions = process.env.GITHUB_ACTIONS === "true";
  for (const item of items) {
    const text = `pending gate review: ${item}`;
    console.log(
      actions ? `::warning title=License pending gate review::${text}` : `warning: ${text}`,
    );
  }
}

/** Warns about pending items, or fails on them in gate mode. */
export function reportPending(items: readonly string[]): void {
  if (items.length === 0) return;
  if (GATE) {
    fail([
      `License gate: ${items.length} item(s) pending gate review; clear them with Chris:`,
      ...items.map((i) => `  - ${i}`),
    ]);
  }
  warnPending(items);
}
