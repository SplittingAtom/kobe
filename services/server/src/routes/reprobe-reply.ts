import type { ReprobeOutcome, ReprobeResult } from "../connectors/reprobe.js";
import { PIN_MESSAGES } from "./connector-messages.js";

/**
 * The Re-probe route's answers (KOBE-430): what happened in plain words. Failures are Kobe's own
 * fixed sentences per failure code, never the remote server's text, a URL or a key.
 */
type Status = 200 | 409 | 429 | 502;

export interface ReprobeReply {
  readonly status: Status;
  readonly body: Record<string, unknown>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const REPROBE_AUTH =
  "The server asked for credentials. Kobe re-probes with the connector's site-wide key, else your own key for it, else the key of the admin who last pinned or approved it (add one at My connector keys); never a member's. Its tools stay as they were.";
const REPROBE_SITE_AUTH =
  "The server asked for credentials: set (or re-enter) this connector's site-wide key. Its tools stay as they were.";
const REPROBE_FAILURES: Readonly<Record<string, string>> = {
  changed:
    "The connector changed while it was being probed (someone edited it), so nothing was applied. Re-probe it again.",
  not_pinned: "The connector was disabled or removed while it was being probed.",
  not_found: "The connector was removed while it was being probed.",
};

function failureMessage(reason: string, credentialSource: string | undefined): string {
  if (reason === "auth_required") {
    return credentialSource === "site" ? REPROBE_SITE_AUTH : REPROBE_AUTH;
  }
  const own = REPROBE_FAILURES[reason];
  if (own !== undefined) return own;
  const pin = (PIN_MESSAGES as Readonly<Record<string, string>>)[reason];
  const why = pin ?? `The server could not be checked (${reason.replaceAll("_", " ")}).`;
  return `${why} Its tools stay as they were.`;
}

function successMessage(outcome: Exclude<ReprobeOutcome, { status: "failed" }>): string {
  if (outcome.status === "unchanged") return "No changes: the server lists the same tools.";
  if (outcome.status === "pinned") return `Pinned ${plural(outcome.tools, "tool")}.`;
  const { changed, added, removed, templates } = outcome;
  const tools =
    changed + added > 0
      ? `${changed} changed, ${added} added, ${removed} removed. Review them to offer them again.`
      : `${removed} removed. Removed tools are no longer offered.`;
  const pending = templates.changed + templates.added + templates.invalid;
  return pending > 0 ? `${tools} ${plural(pending, "app template")} to review.` : tools;
}

const REFUSALS: Readonly<Record<"disabled" | "rate_limited" | "busy", ReprobeReply>> = {
  disabled: {
    status: 409,
    body: { code: "connector_disabled", message: "Enable the connector to re-probe it." },
  },
  rate_limited: {
    status: 429,
    body: {
      code: "rate_limited",
      message: "This connector was re-probed several times just now. Try again in a few minutes.",
    },
  },
  busy: {
    status: 409,
    body: {
      code: "refresh_running",
      message: "Kobe is checking this connector right now. Try again in a minute.",
    },
  },
};

export function reprobeReply(
  result: Exclude<ReprobeResult, { kind: "not_found" }>,
  credentialSource: string | undefined,
): ReprobeReply {
  if (result.kind !== "done") return REFUSALS[result.kind];
  const { outcome } = result;
  if (outcome.status !== "failed") {
    return { status: 200, body: { refresh: { ...outcome, message: successMessage(outcome) } } };
  }
  const message = failureMessage(outcome.reason, credentialSource);
  if (outcome.reason === "changed") return { status: 409, body: { code: "changed", message } };
  return { status: 502, body: { code: "reprobe_failed", failure: outcome.reason, message } };
}
