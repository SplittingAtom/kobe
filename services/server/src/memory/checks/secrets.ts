import { matchSecret } from "@kobe/skill-scanner";
import { secretViews } from "./text.js";

/**
 * Secret scan (KOBE-379, SM18): the skill scanner's secret rules (`SECRET_RULES` in
 * `@kobe/skill-scanner`, not a copy), run over every view of the text (as written, normalised,
 * whitespace removed). A hit blocks the save at every scope with `memory_secret`; there is no
 * override.
 */

/** People's names for the scanner's rule ids (never the matched value). */
const SECRET_NAMES: Readonly<Record<string, string>> = {
  "aws-access-key": "an AWS access key",
  "github-token": "a GitHub token",
  "private-key": "a private key",
  "slack-token": "a Slack token",
  "api-key": "an API key",
  "google-api-key": "a Google API key",
  "generic-assignment": "a password or token",
};

export interface SecretHit {
  /** The scanner rule that matched. */
  readonly rule: string;
  /** What it looks like, for people ("a GitHub token"). */
  readonly label: string;
}

/** The first secret found in `text`, or undefined. */
export function findSecret(text: string): SecretHit | undefined {
  for (const view of secretViews(text)) {
    const rule = matchSecret(view);
    if (rule) return { rule, label: SECRET_NAMES[rule] ?? "a credential" };
  }
  return undefined;
}
