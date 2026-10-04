"use client";

import { useCallback, useContext, useEffect, useState } from "react";
import type { KobeEventPayload } from "@kobe/protocol";
import type { ApiError } from "../../lib/api/client";
import type { ChatApi } from "../../lib/chat/api";
import type { EgressRequest } from "../../lib/chat/types";
import { ChatSessionContext, useKobeExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

/** How often a pending request's status is re-read while the notice is on screen. */
export const PENDING_POLL_MS = 20_000;

type Api = Pick<ChatApi, "requestEgressAccess" | "egressRequests">;

type View =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "request"; readonly request: EgressRequest }
  | { readonly kind: "enabled"; readonly pattern: string }
  | { readonly kind: "error"; readonly error: ApiError };

function statusText(view: View, domain: string): string | null {
  switch (view.kind) {
    case "request":
      if (view.request.status === "pending") {
        return "Access requested: your team admins were notified. Kobe tells you when they decide.";
      }
      return view.request.status === "approved"
        ? `A team admin enabled ${view.request.pattern}. Ask the agent to try again.`
        : `A team admin denied access to ${domain}.`;
    case "enabled":
      return `${view.pattern} is enabled for your team now. Ask the agent to try again.`;
    case "error":
      return view.error.message;
    default:
      return null;
  }
}

/**
 * U12 / D28: a blocked domain is a clear notice; when the domain is in the install's ceiling the
 * member can **Request access**, which notifies the team's admins (domain + this thread's id). No
 * self-allow: the button only asks. The notice shows the request's state (read back on mount, so a
 * reload keeps it, and re-read while pending).
 */
export function EgressNotice({
  payload,
  api,
  threadId,
  pollMs = PENDING_POLL_MS,
}: {
  readonly payload: KobeEventPayload<"egress.blocked">;
  readonly api: Api | undefined;
  readonly threadId: string | undefined;
  readonly pollMs?: number;
}) {
  const [view, setView] = useState<View>({ kind: "idle" });
  const domain = payload.domain;
  const canRequest = payload.request_access && api !== undefined;

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

  const request = async () => {
    if (!api) return;
    setView({ kind: "sending" });
    const res = await api.requestEgressAccess(domain, threadId);
    if (res.ok) {
      setView({ kind: "request", request: res.data.request });
    } else if (res.error.code === "already_enabled") {
      setView({ kind: "enabled", pattern: domain });
    } else {
      setView({ kind: "error", error: res.error });
    }
  };

  const text = statusText(view, domain);
  const showButton =
    canRequest && (view.kind === "idle" || view.kind === "sending" || view.kind === "error");
  return (
    <div className={styles.denied} role="note">
      <p>
        Internet access to <strong>{domain}</strong> was blocked by your team&apos;s egress policy.
        {payload.request_access
          ? " A team admin can allow it."
          : " It is outside what this install allows."}
      </p>
      {showButton ? (
        <button type="button" onClick={() => void request()} disabled={view.kind === "sending"}>
          Request access<span className={styles.visuallyHidden}> to {domain}</span>
        </button>
      ) : null}
      {text ? (
        <p role="status" className={view.kind === "error" ? styles.errorText : undefined}>
          {text}
        </p>
      ) : null}
    </div>
  );
}

/** The notice with the chat's API and the thread on screen. */
export function ConnectedEgressNotice({
  payload,
}: {
  readonly payload: KobeEventPayload<"egress.blocked">;
}) {
  const session = useContext(ChatSessionContext);
  const threadId = useKobeExtras()?.state.threadId ?? undefined;
  return <EgressNotice payload={payload} api={session?.api} threadId={threadId} />;
}
