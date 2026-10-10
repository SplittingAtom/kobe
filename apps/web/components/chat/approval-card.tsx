"use client";

import { useEffect, useId, useState } from "react";
import type { KobeEventPayload } from "@kobe/protocol";
import type { ApiError } from "../../lib/api/client";
import type { ChatApi } from "../../lib/chat/api";
import { visible } from "../../lib/security/visible";
import styles from "./chat.module.css";

type Requested = KobeEventPayload<"approval.requested">;
type Resolved = KobeEventPayload<"approval.resolved">;

/** "Always allow" durations offered with an approval (seconds; undefined = until revoked). */
export const REMEMBER_CHOICES = [
  { label: "for 1 day", seconds: 24 * 3600 },
  { label: "for 30 days", seconds: 30 * 24 * 3600 },
  { label: "until I revoke it", seconds: undefined },
] as const;

const RISK_LABEL: Record<Requested["risk"], string> = {
  read: "Reads data",
  write: "Changes data",
  destructive: "Can delete or overwrite",
};

const EXPIRED_TEXT: Record<Exclude<Resolved["cause"], "user">, string> = {
  ttl: "The approval request expired after 1 hour without an answer. The tool did not run.",
  run_cancelled: "The run was stopped before you answered. The tool did not run.",
  run_interrupted: "The run was interrupted before you answered. The tool did not run.",
  budget_exhausted: "The budget is used up, so the request expired. The tool did not run.",
  run_failed: "The run failed before you answered. The tool did not run.",
};

/** What the card says once the request is answered (the stream's `approval.resolved`). */
export function resolvedText(resolved: Resolved): string {
  if (resolved.decision === "allowed") {
    return resolved.remembered
      ? "Approved. Kobe will not ask again for this tool (revocable in settings)."
      : "Approved.";
  }
  if (resolved.decision === "denied") return "Denied. The tool did not run.";
  return EXPIRED_TEXT[resolved.cause === "user" ? "run_interrupted" : resolved.cause];
}

export { visible };

/** Pretty JSON of the input, with invisible characters escaped (the newlines are formatting). */
export function pretty(input: unknown): string {
  try {
    return visible(JSON.stringify(input, null, 2) ?? "");
  } catch {
    return "";
  }
}

/** Anything outside printable ASCII in a tool name (lookalike letters, hidden characters). */
const NON_ASCII = /[^\x20-\x7e]/;

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The approval card (spec U6, D29): tool, the exact input that will run, risk, why it needs
 * approval, when it expires; Allow / Deny, and "always allow this tool" (a remember-rule for
 * exactly this tool, with an expiry). The server decides who may answer and signs the approval;
 * this card only asks (`POST /v1/approvals/{id}`) and then waits for `approval.resolved`.
 */
export function ApprovalCard({
  requested,
  resolved,
  api,
  now = () => Date.now(),
}: {
  readonly requested: Requested;
  readonly resolved: Resolved | undefined;
  readonly api: Pick<ChatApi, "decideApproval" | "getApproval"> | undefined;
  readonly now?: () => number;
}) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sent, setSent] = useState<"allow" | "deny" | null>(null);
  const [remember, setRemember] = useState(false);
  const [choice, setChoice] = useState(0);
  const approvalId = requested.approval_id;
  // A resumed run keeps no inputs in its resume point: read the exact input back. Until it is
  // here, Allow stays off — the card must never approve an input it isn't showing.
  const inputMissing = Object.keys(requested.input).length === 0;
  const [input, setInput] = useState<unknown>(requested.input);
  const [inputState, setInputState] = useState<"ready" | "loading" | "failed">(
    inputMissing ? "loading" : "ready",
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!inputMissing || resolved || !api) return;
    let live = true;
    setInputState("loading");
    api
      .getApproval(approvalId)
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setInput(res.data.input);
          setInputState("ready");
        } else setInputState("failed");
      })
      .catch(() => {
        if (live) setInputState("failed");
      });
    return () => {
      live = false;
    };
  }, [api, approvalId, inputMissing, resolved, attempt]);

  if (resolved) {
    return (
      <p className={resolved.decision === "allowed" ? styles.notice : styles.denied} role="note">
        {resolvedText(resolved)}
      </p>
    );
  }
  const expired = Date.parse(requested.expires_at) <= now();
  // Every unicode-escaped character of the name, so lookalikes can't pass for another tool.
  const toolShown = visible(requested.tool).replace(
    /[^\x20-\x7e]/gu,
    (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
  // A remember-rule allows every future input of the tool: not offered for destructive ones.
  const canRemember = requested.risk !== "destructive";
  const decide = async (decision: "allow" | "deny") => {
    if (!api) return;
    setBusy(true);
    setError(null);
    const pick = REMEMBER_CHOICES[choice] ?? REMEMBER_CHOICES[0];
    const res = await api.decideApproval(approvalId, {
      decision,
      ...(decision === "allow" && remember && canRemember
        ? { remember: { toolGlob: requested.tool, expiresIn: pick.seconds } }
        : {}),
    });
    setBusy(false);
    if (res.ok) setSent(decision);
    else setError(res.error);
  };

  return (
    <section
      className={styles.approval}
      role="group"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-why`}
    >
      <p id={`${ids}-title`} className={styles.approvalTitle}>
        <strong>Approval needed</strong> to run <span className={styles.toolName}>{toolShown}</span>{" "}
        <span className={styles.badge}>{RISK_LABEL[requested.risk]}</span>
      </p>
      {NON_ASCII.test(requested.tool) && (
        <p className={styles.denied} role="note">
          This tool name contains non-ASCII characters (shown escaped). It may imitate another
          tool&apos;s name.
        </p>
      )}
      <ul id={`${ids}-why`} className={styles.approvalReasons}>
        {requested.reasons.map((r) => (
          <li key={`${r.stage}:${r.code}:${r.rule_id ?? ""}`}>{r.message}</li>
        ))}
      </ul>
      <p className={styles.who}>Exactly this input runs if you allow it:</p>
      {inputState === "ready" ? (
        <pre className={styles.toolPre} aria-label="Input to approve">
          {pretty(input)}
        </pre>
      ) : inputState === "loading" ? (
        <p className={styles.hint} role="status">
          Loading the exact input…
        </p>
      ) : (
        <p className={styles.errorText} role="alert">
          The input could not be loaded, so it can&apos;t be approved yet.{" "}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {expired ? (
        <p className={styles.denied} role="note">
          This approval request expired. The tool did not run.
        </p>
      ) : sent ? (
        <p className={styles.notice} role="status">
          {sent === "allow" ? "Approved. Waiting for the tool to run…" : "Denied."}
        </p>
      ) : (
        <>
          {canRemember && (
            <div className={styles.approvalRemember}>
              <label>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  disabled={busy}
                />{" "}
                Always allow <span className={styles.toolName}>{toolShown}</span>
              </label>{" "}
              <select
                aria-label="Remember for"
                value={choice}
                onChange={(e) => setChoice(Number(e.target.value))}
                disabled={busy || !remember}
              >
                {REMEMBER_CHOICES.map((c, i) => (
                  <option key={c.label} value={i}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className={styles.approvalActions}>
            <button
              type="button"
              onClick={() => void decide("allow")}
              disabled={busy || !api || inputState !== "ready"}
            >
              Allow
            </button>
            <button type="button" onClick={() => void decide("deny")} disabled={busy || !api}>
              Deny
            </button>
            <span className={styles.hint}>Expires at {timeOf(requested.expires_at)}</span>
          </div>
          {error && (
            <p className={styles.errorText} role="alert">
              {error.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
