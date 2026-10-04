"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { fetchTeamAccess } from "../../lib/admin/api/access";
import type { ApiError, ApiResult } from "../../lib/api/client";
import type { TeamAccess } from "../../lib/admin/nav/types";
import { TeamSwitcher } from "../../app/team-switcher";
import { ACTIVE_TEAM_EVENT } from "../../lib/teams";
import { ConsoleAccessContext } from "../admin/console-context";
import { ErrorNotice } from "../admin/error-notice";
import styles from "../admin/admin.module.css";

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

  return (
    <div className={styles.shell} data-kobe-console="">
      <header className={styles.header}>
        <div className={styles.brandRow}>
          <p className={styles.brand}>
            <Link href="/">Kobe</Link> <span aria-hidden="true">/</span> My area
          </p>
          <TeamSwitcher />
        </div>
        {state.status === "ready" && <p className={styles.who}>{state.access.user.name}</p>}
      </header>
      <div className={`${styles.body} ${styles.bodySingle}`}>
        <main id="console-main" className={styles.main}>
          {state.status === "loading" && <p role="status">Checking your access…</p>}
          {state.status === "error" && <ErrorNotice error={state.error} />}
          {state.status === "ready" && (
            <ConsoleAccessContext.Provider value={state.access}>
              {/* Keyed by team: a page never carries one team's state into another's. */}
              <div key={state.access.team.id}>{children}</div>
            </ConsoleAccessContext.Provider>
          )}
        </main>
      </div>
    </div>
  );
}
