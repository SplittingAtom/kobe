"use client";

import { useEffect, useState, type ReactNode } from "react";
import { fetchTeamAccess } from "../../lib/admin/api/access";
import type { ApiError, ApiResult } from "../../lib/api/client";
import type { TeamAccess } from "../../lib/admin/nav/types";
import { TeamSwitcher } from "../../app/team-switcher";
import { ACTIVE_TEAM_EVENT } from "../../lib/teams";
import { ConsoleAccessContext } from "../admin/console-context";
import { ConsoleThemeToggle } from "../admin/console-theme-toggle";
import { ErrorNotice } from "../admin/error-notice";
import { Brand } from "../shell/brand";
import { ChatReturnLink } from "../shell/chat-return-link";
import { ConsoleLayout, ConsoleMain, ConsoleWho, useInPanel } from "../ui/console";

type State =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly access: TeamAccess };

/**
 * Frame for the member's own area (KOBE-97). Any member of the active team may open it: no admin
 * permission is checked here, and every API call checks ownership again. It reuses the team
 * access context so the admin builder components work unchanged.
 */
export function MyAgentsShell({
  children,
  loadAccess = () => fetchTeamAccess(),
}: {
  readonly children: ReactNode;
  readonly loadAccess?: () => Promise<ApiResult<TeamAccess>>;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // A fresh session has no active team until the switcher picks one: ask again when it does.
  useEffect(() => {
    const retry = () => {
      setState({ status: "loading" });
      setAttempt((n) => n + 1);
    };
    window.addEventListener(ACTIVE_TEAM_EVENT, retry);
    return () => window.removeEventListener(ACTIVE_TEAM_EVENT, retry);
  }, []);

  useEffect(() => {
    let current = true;
    loadAccess().then(
      (res) => {
        if (!current) return;
        setState(
          res.ok ? { status: "ready", access: res.data } : { status: "error", error: res.error },
        );
      },
      () => {
        if (current) {
          setState({
            status: "error",
            error: { status: 0, code: "client_error", message: "Could not check your access." },
          });
        }
      },
    );
    return () => {
      current = false;
    };
    // `loadAccess` is a stable default or a test stub; `attempt` drives the re-check.
  }, [attempt]);

  // Over the workspace (KOBE-452) the panel's header names the page and closes it.
  const panel = useInPanel();
  return (
    <ConsoleLayout
      panel={panel}
      brand={
        <>
          <ChatReturnLink>
            <Brand />
          </ChatReturnLink>{" "}
          <span aria-hidden="true">/</span> My area
        </>
      }
      headerStart={<TeamSwitcher />}
      headerEnd={
        <>
          {state.status === "ready" && <ConsoleWho>{state.access.user.name}</ConsoleWho>}
          <ConsoleThemeToggle />
        </>
      }
    >
      <ConsoleMain>
        {state.status === "loading" && <p role="status">Checking your access…</p>}
        {state.status === "error" && <ErrorNotice error={state.error} />}
        {state.status === "ready" && (
          <ConsoleAccessContext.Provider value={state.access}>
            {/* Keyed by team: a page never carries one team's state into another's. */}
            <div key={state.access.team.id}>{children}</div>
          </ConsoleAccessContext.Provider>
        )}
      </ConsoleMain>
    </ConsoleLayout>
  );
}
