"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { TeamSwitcher } from "../../app/team-switcher";
import { fetchTeamAccess } from "../../lib/admin/api/access";
import type { TeamAccess } from "../../lib/admin/nav/types";
import type { ApiError, ApiResult } from "../../lib/api/client";
import { MY_SECTIONS, mySectionForPath } from "../../lib/my/nav";
import { ACTIVE_TEAM_EVENT } from "../../lib/teams";
import { ConsoleAccessContext } from "../admin/console-context";
import { ErrorNotice } from "../admin/error-notice";
import styles from "../admin/admin.module.css";

type State =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly access: TeamAccess };

/**
 * Shell of the member's own area. Unlike the consoles it asks for no admin permission: any team
 * member gets in, and the pages' APIs check what they need (personal items are owner-only).
 * It provides the same team access context the team console pages read.
 */
export function MyShell({
  pathname,
  children,
  loadAccess = () => fetchTeamAccess(),
}: {
  readonly pathname: string;
  readonly children: ReactNode;
  readonly loadAccess?: () => Promise<ApiResult<TeamAccess>>;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

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
        if (current)
          setState({
            status: "error",
            error: { status: 0, code: "client_error", message: "Could not check your access." },
          });
      },
    );
    return () => {
      current = false;
    };
    // loadAccess is a stable default or a test stub; `attempt` drives reloads.
  }, [attempt]);

  const current = mySectionForPath(pathname);
  return (
    <div className={styles.shell} data-kobe-console="">
      <a href="#console-main" className={styles.skipLink}>
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          <p className={styles.brand}>
            <Link href="/">Kobe</Link> <span aria-hidden="true">/</span> My area
          </p>
          <TeamSwitcher />
        </div>
        {state.status === "ready" && <p className={styles.who}>{state.access.user.name}</p>}
      </header>
      <div className={styles.body}>
        <nav aria-label="My area sections" className={styles.nav}>
          <ul>
            {MY_SECTIONS.map((s) => (
              <li key={s.id}>
                <Link
                  href={s.href}
                  className={styles.navLink}
                  aria-current={current?.id === s.id ? "page" : undefined}
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
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
