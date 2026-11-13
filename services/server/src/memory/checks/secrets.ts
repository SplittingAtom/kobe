import { matchSecret, matchSplitSecret } from "@kobe/skill-scanner";
import { collapsedView, decodedRuns, secretViews } from "./text.js";

/**
 * Secret scan (KOBE-379, SM18): the skill scanner's secret rules (`SECRET_RULES` in
 * `@kobe/skill-scanner`, not a copy), run over every view of the text: as written, normalised,
 * split tokens joined, every separator between token characters removed (prefix-anchored rules
 * only), and base64 / hex runs decoded once. A hit blocks the save at every scope with
 * `memory_secret`; there is no override.
 */

/** People's names for the scanner's rule ids (never the matched value). */
const SECRET_NAMES: Readonly<Record<string, string>> = {
  "aws-access-key": "an AWS access key",
  "github-token": "a GitHub token",
  "private-key": "a private key",
  "slack-token": "a Slack token",
  "stripe-key": "a Stripe key",
  "gitlab-token": "a GitLab token",
  "api-key": "an API key",
  "google-api-key": "a Google API key",
  jwt: "a sign-in token (JWT)",
  "azure-account-key": "an Azure storage key",
  "connection-string": "a password in a connection string",
  "generic-assignment": "a password or token",
  "password-unquoted": "a password or token",
};

export interface SecretHit {
  /** The scanner rule that matched. */
  readonly rule: string;
  /** What it looks like, for people ("a GitHub token"). */
  readonly label: string;
}

const hit = (rule: string): SecretHit => ({ rule, label: SECRET_NAMES[rule] ?? "a credential" });

function scanViews(text: string): string | undefined {
  for (const view of secretViews(text)) {
    const rule = matchSecret(view);
    if (rule) return rule;
  }
  return matchSplitSecret(collapsedView(text));
}

/** The first secret found in `text` (or in what its encoded runs decode to), or undefined. */
export function findSecret(text: string): SecretHit | undefined {
  const direct = scanViews(text);
  if (direct) return hit(direct);
  for (const decoded of decodedRuns(text)) {
    const rule = scanViews(decoded);
    if (rule) return hit(rule);
  }
  return undefined;
}
