import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { InstallAccess, TeamAccess } from "../../lib/admin/nav/types";
import { ConsoleAccessContext } from "./console-context";

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

type Reply = readonly [number, unknown?];

/**
 * Stubs global fetch with routes "METHOD /path" → reply (or a list of replies, used in turn; the
 * last repeats). Unrouted requests get a 404 so a wrong URL fails the test visibly.
 */
export function stubApi(routes: Record<string, Reply | readonly Reply[]>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const served = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const key = `${method} ${url}`;
      calls.push({ method, url, headers: new Headers(init.headers), body: init.body });
      const route = routes[key];
      if (route === undefined) {
        return new Response(JSON.stringify({ code: "not_found", message: `unrouted ${key}` }), {
          status: 404,
        });
      }
      const replies = (Array.isArray(route[0]) ? route : [route]) as readonly Reply[];
      const n = served.get(key) ?? 0;
      served.set(key, n + 1);
      const [status, body] = replies[Math.min(n, replies.length - 1)] ?? [500];
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

export const ME = { id: "u-me", name: "Ada", email: "ada@x.io" };

export function renderInstall(
  ui: ReactElement,
  installRole: InstallAccess["installRole"] = "admin",
) {
  const access: InstallAccess = { console: "install", user: ME, installRole };
  return render(<ConsoleAccessContext.Provider value={access}>{ui}</ConsoleAccessContext.Provider>);
}

export const TEAM = { id: "t-1", slug: "fin", name: "Finance" };

export function renderTeam(ui: ReactElement) {
  const access: TeamAccess = {
    console: "team",
    user: ME,
    team: TEAM,
    role: "team_admin",
    permissions: ["team.members.manage", "team.agents.suspend"],
  };
  return render(<ConsoleAccessContext.Provider value={access}>{ui}</ConsoleAccessContext.Provider>);
}

export function summary(of: RecordedCall[]): string[] {
  return of.map((c) => `${c.method} ${c.url}`);
}
