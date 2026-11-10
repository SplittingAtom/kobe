"use client";

import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { KobeEventPayload } from "@kobe/protocol";
import type { ApiError } from "../../lib/api/client";
import type { ChatApi } from "../../lib/chat/api";
import type { EgressRequest, EgressViewer } from "../../lib/chat/types";
import { patternChoices } from "../../lib/egress-patterns";
import { CloseNoticeButton, useClosedNotice } from "./closable-notice";
import { ChatSessionContext, useKobeExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

/** How often a pending request's status is re-read while the notice is on screen. */
export const PENDING_POLL_MS = 20_000;

type Api = Pick<ChatApi, "requestEgressAccess" | "egressRequests"> &
  Partial<Pick<ChatApi, "decideEgressRequest" | "egressViewer">>;

type Scope = "team" | "site";

type View =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "request"; readonly request: EgressRequest }
  | { readonly kind: "enabled"; readonly pattern: string }
  | { readonly kind: "decided"; readonly text: string }
  | { readonly kind: "error"; readonly error: ApiError; readonly request?: EgressRequest };

/** Who decides: a team-scope request (pattern in the ceiling) goes to the team's admins. */
function scopeOf(reason: string | undefined, request: EgressRequest | undefined): Scope {
  if (request?.scope) return request.scope;
  return reason === "not_in_ceiling" || reason === "forbidden_address" ? "site" : "team";
}

const audience = (scope: Scope) => (scope === "team" ? "your team admins" : "the site admins");
const deciderWord = (scope: Scope) => (scope === "team" ? "A team admin" : "A site admin");

function statusText(view: View, domain: string, scope: Scope): string | null {
  switch (view.kind) {
    case "request":
      if (view.request.status === "pending") {
        return `Access requested: ${audience(scope)} were notified. Kobe tells you when they decide.`;
      }
      return view.request.status === "approved"
        ? `${deciderWord(scope)} enabled ${view.request.pattern}. Ask the agent to try again.`
        : `${deciderWord(scope)} denied access to ${domain}.`;
    case "enabled":
      return `${view.pattern} is enabled for your team now. Ask the agent to try again.`;
    case "decided":
      return view.text;
    case "error":
      return view.error.message;
    default:
      return null;
  }
}

/**
 * U12 / D28, egress access (KOBE-602, KOBE-604): a blocked host is a clear notice. Every block a
 * request can fix offers **Request access** (the sentence names who decides: the team's admins for
 * a host in the ceiling, the site admins otherwise). A viewer who may decide (a site admin any
 * request, a team admin a team-scope one) also gets **Approve** / **Deny**, a pattern choice (the
 * host, then its parent wildcards) and, for a site admin, **Internal (same cluster)**. The roles
 * only show or hide the controls: the server decides and its error codes are shown as they come.
 * No self-allow for members: their button only asks. The notice shows the request's state (read
 * back on mount, so a reload keeps it, and re-read while pending).
 *
 * With `closeId` (the event's id) the viewer can close it (KOBE-468): it stays closed in this
 * browser. A closed notice stops polling; a pending request stays pending.
 */
export function EgressNotice({
  closeId,
  ...props
}: NoticeProps & { readonly closeId?: string | undefined }) {
  const [closed, close] = useClosedNotice(closeId);
  if (closed) return null;
  return <EgressNoticeBody {...props} onClose={closeId === undefined ? undefined : close} />;
}

interface NoticeProps {
  readonly payload: KobeEventPayload<"egress.blocked">;
  readonly api: Api | undefined;
  readonly threadId: string | undefined;
  readonly pollMs?: number;
}

const NOT_ADMIN: EgressViewer = { siteAdmin: false, teamAdmin: false, teamName: "your team" };

/** The viewer's admin roles, read once and only when the notice can be acted on. */
function useViewer(api: Api | undefined, enabled: boolean): EgressViewer {
  const [viewer, setViewer] = useState<EgressViewer>(NOT_ADMIN);
  useEffect(() => {
    if (!enabled || !api?.egressViewer) return;
    let live = true;
    void api.egressViewer().then((res) => {
      if (live && res.ok) setViewer(res.data);
    });
    return () => {
      live = false;
    };
  }, [api, enabled]);
  return viewer;
}

function EgressNoticeBody({
  payload,
  api,
  threadId,
  pollMs = PENDING_POLL_MS,
  onClose,
}: NoticeProps & { readonly onClose: (() => void) | undefined }) {
  const [view, setView] = useState<View>({ kind: "idle" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [internalChoice, setInternalChoice] = useState<boolean | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [focusStatus, setFocusStatus] = useState(0);
  const ids = useId();
  const domain = payload.domain;
  const reason = payload.reason;
  const canRequest = payload.request_access && api !== undefined;
  const viewer = useViewer(api, canRequest);

  const refresh = useCallback(async () => {
    if (!api) return;
    const res = await api.egressRequests(domain);
    if (!res.ok) return;
    const latest = res.data.requests[0];
    if (latest) setView({ kind: "request", request: latest });
  }, [api, domain]);

  useEffect(() => {
    if (!canRequest) return;
    void refresh();
  }, [canRequest, refresh]);

  const pending = view.kind === "request" && view.request.status === "pending";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pending, pollMs, refresh]);

  // After a decision the controls are gone: keep keyboard focus on the result.
  useEffect(() => {
    if (focusStatus > 0) statusRef.current?.focus();
  }, [focusStatus]);

  const open = view.kind === "request" && view.request.status === "pending" ? view.request : null;
  const failed = view.kind === "error" ? view.request : undefined;
  const known = open ?? failed;
  const scope = scopeOf(reason, known);
  const mayDecide =
    canRequest &&
    api?.decideEgressRequest !== undefined &&
    (viewer.siteAdmin || (viewer.teamAdmin && scope === "team"));
  const choices = patternChoices(domain);
  const preset = known?.pattern && choices.includes(known.pattern) ? known.pattern : domain;
  const pattern = chosen ?? preset;
  const internal = internalChoice ?? known?.internal ?? reason === "forbidden_address";

  const failWith = (error: ApiError, request?: EgressRequest) =>
    setView(request ? { kind: "error", error, request } : { kind: "error", error });

  /** The request to decide: the member's pending one, else a new one made as the admin. */
  const requestToDecide = async (chat: Api): Promise<EgressRequest | ApiError> => {
    if (known) return known;
    const made = await chat.requestEgressAccess(domain, threadId, reason);
    if (made.ok) return made.data.request;
    return made.error;
  };

  const request = async () => {
    if (!api) return;
    setView({ kind: "sending" });
    const res = await api.requestEgressAccess(domain, threadId, reason);
    if (res.ok) {
      setView({ kind: "request", request: res.data.request });
    } else if (res.error.code === "already_enabled") {
      setView({ kind: "enabled", pattern: domain });
    } else {
      failWith(res.error);
    }
    setFocusStatus((n) => n + 1);
  };

  const decide = async (decision: "approve" | "deny") => {
    if (!api?.decideEgressRequest) return;
    setView({ kind: "sending" });
    const target = await requestToDecide(api);
    if ("code" in target) {
      if (target.code === "already_enabled") setView({ kind: "enabled", pattern: domain });
      else failWith(target);
      setFocusStatus((n) => n + 1);
      return;
    }
    const approving = decision === "approve";
    const res = await api.decideEgressRequest(target.id, {
      decision,
      // The request's own pattern is the default; only an explicit pick overrides it.
      ...(approving && chosen !== null ? { pattern: chosen } : {}),
      ...(approving && viewer.siteAdmin && internal ? { internal: true } : {}),
    });
    if (res.ok) {
      setView({
        kind: "decided",
        text: approving
          ? `Enabled ${res.data.pattern} for ${viewer.teamName}. Ask the agent to try again.`
          : `Denied access to ${domain} for ${viewer.teamName}.`,
      });
    } else {
      failWith(res.error, target);
    }
    setFocusStatus((n) => n + 1);
  };

  const text = statusText(view, domain, scope);
  const sending = view.kind === "sending";
  const finished = view.kind === "decided" || view.kind === "enabled";
  const memberCanAsk =
    canRequest &&
    !mayDecide &&
    (view.kind === "idle" || view.kind === "sending" || view.kind === "error");
  const showDecide =
    mayDecide &&
    !finished &&
    (view.kind === "idle" ||
      view.kind === "sending" ||
      view.kind === "error" ||
      (view.kind === "request" && view.request.status === "pending"));
  const someoneDecided = view.kind === "request" && view.request.status !== "pending";
  return (
    <div className={onClose ? `${styles.denied} ${styles.closable}` : styles.denied} role="note">
      <div className={styles.closableBody}>
        <p>
          Internet access to <strong>{domain}</strong> was blocked by your team&apos;s egress
          policy.
          {payload.request_access
            ? ` ${scope === "team" ? "Your team admins" : "The site admins"} can allow it.`
            : " It is outside what this site allows."}
        </p>
        {memberCanAsk ? (
          <button type="button" onClick={() => void request()} disabled={sending}>
            Request access<span className={styles.visuallyHidden}> to {domain}</span>
          </button>
        ) : null}
        {showDecide && !someoneDecided ? (
          <fieldset disabled={sending} aria-label={`Decide access to ${domain}`}>
            <div>
              <label htmlFor={`${ids}-pattern`}>Allow </label>
              <select
                id={`${ids}-pattern`}
                value={pattern}
                onChange={(e) => setChosen(e.target.value)}
              >
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            {viewer.siteAdmin ? (
              <div>
                <input
                  id={`${ids}-internal`}
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternalChoice(e.target.checked)}
                />{" "}
                <label htmlFor={`${ids}-internal`}>Internal (same cluster)</label>
              </div>
            ) : null}
            <button type="button" onClick={() => void decide("approve")}>
              Approve<span className={styles.visuallyHidden}> access to {domain}</span>
            </button>{" "}
            {known ? (
              <button type="button" onClick={() => void decide("deny")}>
                Deny<span className={styles.visuallyHidden}> access to {domain}</span>
              </button>
            ) : null}
          </fieldset>
        ) : null}
        {text ? (
          <p
            ref={statusRef}
            tabIndex={-1}
            role="status"
            className={view.kind === "error" ? styles.errorText : undefined}
          >
            {text}
          </p>
        ) : null}
      </div>
      {onClose ? (
        <CloseNoticeButton label={`Close notice about ${domain}`} onClose={onClose} />
      ) : null}
    </div>
  );
}

/** The notice with the chat's API and the thread on screen. */
export function ConnectedEgressNotice({
  payload,
  closeId,
}: {
  readonly payload: KobeEventPayload<"egress.blocked">;
  readonly closeId?: string | undefined;
}) {
  const session = useContext(ChatSessionContext);
  const threadId = useKobeExtras()?.state.threadId ?? undefined;
  return (
    <EgressNotice payload={payload} api={session?.api} threadId={threadId} closeId={closeId} />
  );
}
