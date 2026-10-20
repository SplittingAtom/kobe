// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { rememberLastThread } from "../../lib/shell/last-thread";
import { FakeNavigation } from "../../lib/shell/testing/fake-navigation";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { ConsoleShell } from "../admin/console-shell";
import { ChatApp } from "../chat/chat-app";
import { composer, streamed, streaming } from "../chat/testing";
import { consolePortalContainer } from "../ui/chat-portal";
import { useUnsavedChanges } from "../ui/console";
import { useEditorWidth } from "../skills/define-layout";

// Next's Link navigates through the app router, which a test has none of: a plain link that pushes
// on the router in context, as the real one does on a plain click.
vi.mock("next/link", async () => {
  const React = await import("react");
  const { AppRouterContext: Router } =
    await import("next/dist/shared/lib/app-router-context.shared-runtime");
  return {
    default: function TestLink({
      href,
      onClick,
      ...props
    }: { readonly href: string } & React.ComponentProps<"a">) {
      const router = React.useContext(Router);
      return (
        <a
          href={href}
          {...props}
          onClick={(e) => {
            onClick?.(e);
            if (e.defaultPrevented || !router) return;
            e.preventDefault();
            router.push(href);
          }}
        />
      );
    },
  };
});

/**
 * KOBE-452: the consoles, My agents, Skills and the My area open as a panel over the workspace,
 * at their own addresses, with the chat mounted underneath. The router here stands in for Next's:
 * `push` and `replace` move the address and the page; the Navigation API is a fake that follows
 * `window.history`.
 */
const WAIT = { timeout: 10_000 };
let fake: FakeKobe;
let nav: FakeNavigation;
let detach: () => void;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamRole = "team_admin";
  const json = (body: unknown) => Response.json(body);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://kobe.test").pathname;
    if (path === "/v1/me") {
      return json({
        user: { id: "u-1", name: "Ada", email: "ada@example.test", twoFactorEnabled: false },
        siteRole: null,
      });
    }
    if (path === "/v1/team") {
      return json({
        team: { id: fake.teamId, slug: "fin", name: "Finance" },
        role: fake.teamRole,
        permissions: fake.teamRole === "team_admin" ? ["team.members.manage"] : ["team.read"],
      });
    }
    return fake.fetch(input, init);
  });
});

afterEach(() => {
  cleanup();
  detach();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
});

/** A console page with a form, a link to another section and an editor of its own. */
function TestPage({ path }: { readonly path: string }) {
  if (path === "/admin/site") {
    return (
      <ConsoleShell kind="site" pathname={path}>
        <h1>Users</h1>
      </ConsoleShell>
    );
  }
  if (path === "/admin/team/usage") return <Section title="Usage" />;
  if (path === "/me/agents") return <EditorSection />;
  if (path.startsWith("/me/skills/drafts/")) return <EditorWidthPage />;
  return (
    <Section title="Members">
      <form aria-label="Invite" onSubmit={(e) => e.preventDefault()}>
        <input aria-label="Email" />
        <input aria-label="Filter members" type="search" />
        <button type="submit">Invite</button>
      </form>
      <Link href="/admin/team/usage">Usage</Link>
    </Section>
  );
}

function Section({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div data-kobe-console="">
      <main id="console-main">
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

function EditorSection() {
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  return (
    <Section title="Builder">
      <button type="button" onClick={() => setDirty(true)}>
        Edit the prompt
      </button>
      <button type="button" onClick={() => setDirty(false)}>
        Save the prompt
      </button>
    </Section>
  );
}

/** KOBE-459: a Skills panel page that reads and saves the Workbench editor rail's width. */
function EditorWidthPage() {
  const { width, setWidth } = useEditorWidth();
  return (
    <Section title="Draft">
      <p>Width {width ?? "default"}</p>
      <button type="button" onClick={() => setWidth(640)}>
        Widen
      </button>
    </Section>
  );
}

let keys = 0;
// Stable across renders: a new one would start a new chat session.
const newKey = () => `key-${++keys}`;
const noDelay = () => 0;

function TestWorkspace() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const follow = () => setPath(window.location.pathname);
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  const go = useCallback((href: string, replace: boolean) => {
    if (replace) window.history.replaceState({}, "", href);
    else window.history.pushState({}, "", href);
    setPath(new URL(href, window.location.href).pathname);
  }, []);
  const router = useMemo(
    () => ({
      push: (href: string) => go(href, false),
      replace: (href: string) => go(href, true),
      prefetch: () => Promise.resolve(),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => {},
    }),
    [go],
  );
  const route = useMemo(
    () => ({ pathname: path, page: <TestPage path={path} />, ...router }),
    [path, router],
  );
  return (
    <AppRouterContext.Provider
      value={router as unknown as ComponentProps<typeof AppRouterContext.Provider>["value"]}
    >
      <ChatApp
        fetchFn={fake.fetch}
        eventSource={fake.eventSource}
        newKey={newKey}
        reopenDelayMs={noDelay}
        route={route}
      />
    </AppRouterContext.Provider>
  );
}

/** Opens the workspace at `url`, with the fake Navigation API following its history. */
function open(url: string) {
  window.history.replaceState(null, "", url);
  nav = new FakeNavigation(url);
  detach = nav.attach();
  vi.stubGlobal("navigation", nav);
  return render(<TestWorkspace />);
}

async function openThread() {
  const t = fake.addThread("Forecast");
  open(`/?thread=${t}`);
  await screen.findByRole("heading", { level: 2, name: "Forecast" }, WAIT);
  return t;
}

const dialog = (name: string) => screen.findByRole("dialog", { name }, WAIT);
const panelEl = () => document.querySelector<HTMLElement>("[data-kobe-panel]");
const teamConsoleLink = () =>
  screen.findByRole("link", { name: "Team console" }, WAIT) as Promise<HTMLAnchorElement>;

describe("the shell's layout preferences in a panel page (KOBE-459)", () => {
  it("a Skills panel page loads the member's stored editor width and saves a new one", async () => {
    fake.preferences = { workbench_editor_width: 500 };
    open("/me/skills/drafts/d-1");
    const panel = await dialog("Skills");
    expect(await within(panel).findByText("Width 500", undefined, WAIT)).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: "Widen" }));
    expect(within(panel).getByText("Width 640")).toBeTruthy();
    await waitFor(() => expect(fake.preferences).toEqual({ workbench_editor_width: 640 }), WAIT);
  });
});

describe("a panel over the workspace (KOBE-452 ac-1, ac-5)", () => {
  it("Team console opens over the workspace; the thread, draft and scroll stay as they were", async () => {
    const t = await openThread();
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "half a thought");
    const link = await teamConsoleLink();
    await user.click(link);
    const panel = await dialog("Team console");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(within(panel).getByRole("heading", { level: 1, name: "Members" })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/team");
    // The workspace stays mounted underneath, inert while the panel is open.
    expect(input.isConnected).toBe(true);
    expect(input.closest("[inert]")).not.toBeNull();
    expect(panel.closest("[inert]")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Forecast" })).toBeTruthy();
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    // Its dialogs and menus mount at the document's top, over the panel.
    const portal = must(consolePortalContainer());
    expect(portal.parentElement).toBe(document.body);

    await user.click(within(panel).getByRole("button", { name: "Close Team console" }));
    await waitFor(() => expect(panelEl()).toBeNull());
    expect(window.location.pathname).toBe("/");
    expect(new URLSearchParams(window.location.search).get("thread")).toBe(t);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("half a thought");
    expect(input.closest("[inert]")).toBeNull();
    // Focus returns to the control that opened it.
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it("a run keeps streaming under the panel and is where it was when it closes", async () => {
    const t = await openThread();
    const user = userEvent.setup();
    await user.type(await composer(), "count to three{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    fake.agent.delta(runId, "m1", "One, ");
    expect(await screen.findByText(streamed("One,"))).toBeTruthy();
    const stream = fake.openStreams[0];

    await user.click(await teamConsoleLink());
    await dialog("Team console");
    fake.agent.delta(runId, "m1", "two, ");
    fake.agent.delta(runId, "m1", "three.");
    // The same stream, never closed or reopened behind the panel.
    expect(fake.openStreams).toEqual([stream]);
    expect(await screen.findByText(streamed("One, two, three."))).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(panelEl()).toBeNull());
    expect(fake.openStreams).toEqual([stream]);
    expect(screen.getByText(streamed("One, two, three."))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("one panel at a time: opening another replaces it", async () => {
    await openThread();
    const user = userEvent.setup();
    await user.click(await teamConsoleLink());
    const panel = await dialog("Team console");
    await user.click(within(panel).getByRole("link", { name: "Usage" }));
    expect(await within(panel).findByRole("heading", { level: 1, name: "Usage" })).toBeTruthy();
    act(() => {
      window.history.pushState({}, "", "/me/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await dialog("My agents")).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("is still a dialog, full screen, under 820 px and on a phone", async () => {
    resizeWindow(390);
    await openThread();
    act(() => {
      window.history.pushState({}, "", "/admin/team");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const panel = await dialog("Team console");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(within(panel).getByRole("button", { name: "Close Team console" })).toBeTruthy();
  });
});

describe("addresses, Back and reload (KOBE-452 ac-2)", () => {
  it("Back steps inside the panel, then closes it; Forward opens it again", async () => {
    await openThread();
    const user = userEvent.setup();
    await user.click(await teamConsoleLink());
    const panel = await dialog("Team console");
    await user.click(within(panel).getByRole("link", { name: "Usage" }));
    await within(panel).findByRole("heading", { level: 1, name: "Usage" });
    expect(window.location.pathname).toBe("/admin/team/usage");
    act(() => window.history.back());
    expect(await within(panel).findByRole("heading", { level: 1, name: "Members" })).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(panelEl()).toBeNull());
    act(() => window.history.forward());
    expect(await dialog("Team console")).toBeTruthy();
  });

  it("Close after steps inside goes back to the chat: Back then never reopens the panel", async () => {
    const t = await openThread();
    const user = userEvent.setup();
    await user.click(await teamConsoleLink());
    const panel = await dialog("Team console");
    await user.click(within(panel).getByRole("link", { name: "Usage" }));
    await within(panel).findByRole("heading", { level: 1, name: "Usage" });
    await user.click(within(panel).getByRole("button", { name: "Close Team console" }));
    await waitFor(() => expect(panelEl()).toBeNull());
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/?thread=${t}`);
    expect(nav.index).toBe(0);
  });

  it("a link or a reload opens the panel over the last thread; Close replaces its entry", async () => {
    const t = fake.addThread("Forecast");
    rememberLastThread(fake.teamId, t);
    open("/admin/team");
    const panel = await dialog("Team console");
    expect(within(panel).getByRole("heading", { level: 1, name: "Members" })).toBeTruthy();
    // The workspace under it is the member's last thread in this tab, inert although it loaded
    // after the panel opened (review M1).
    const heading = await waitFor(
      () => must(document.querySelector<HTMLElement>("#kobe-chat-main h2")),
      WAIT,
    );
    expect(heading.textContent).toBe("Forecast");
    await waitFor(() => expect(heading.closest("[inert]")).not.toBeNull());
    expect((await composer()).closest("[inert]")).not.toBeNull();
    const before = nav.entries().length;
    await userEvent
      .setup()
      .click(within(panel).getByRole("button", { name: "Close Team console" }));
    await waitFor(() => expect(panelEl()).toBeNull());
    expect(nav.entries()).toHaveLength(before);
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/?thread=${t}`);
    // Nothing had focus: it goes to the conversation.
    await waitFor(() => expect(document.activeElement?.id).toBe("kobe-chat-main"));
  });

  it("a link without a remembered thread opens the panel over a new conversation", async () => {
    open("/admin/team");
    await dialog("Team console");
    expect(await composer()).toBeTruthy();
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(panelEl()).toBeNull());
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
  });

  it("an address from before (?area=memory) opens that page's panel over its thread", async () => {
    const t = fake.addThread("Forecast");
    open(`/?thread=${t}&area=memory`);
    expect(await dialog("My memory")).toBeTruthy();
    expect(window.location.pathname).toBe("/me/memory");
    expect(await screen.findByRole("heading", { level: 2, name: "Forecast" }, WAIT)).toBeTruthy();
  });
});

describe("closing (KOBE-452 ac-3)", () => {
  it("an edit in a form asks before Close; Keep editing keeps it, Discard closes", async () => {
    await openThread();
    const user = userEvent.setup();
    await user.click(await teamConsoleLink());
    const panel = await dialog("Team console");
    // A search box loses nothing: no question.
    await user.type(within(panel).getByLabelText("Filter members"), "ad");
    await user.type(within(panel).getByLabelText("Email"), "bo@example.test");
    await user.click(within(panel).getByRole("button", { name: "Close Team console" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(panelEl()).not.toBeNull();
    // Escape from the field asks too (from the Close button it first hides its tooltip).
    within(panel).getByLabelText("Email").focus();
    await user.keyboard("{Escape}");
    const again = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(again).getByRole("button", { name: "Discard and close" }));
    await waitFor(() => expect(panelEl()).toBeNull());
  });

  it("with unsaved edits, a reload and Back ask too (review L5)", async () => {
    await openThread();
    const user = userEvent.setup();
    await user.click(await teamConsoleLink());
    const panel = await dialog("Team console");
    const reload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(reload()).toBe(false);
    expect(nav.dispatchTraverse(-1)).toBe(false);
    await user.type(within(panel).getByLabelText("Email"), "bo@example.test");
    expect(reload()).toBe(true);
    let cancelled = false;
    act(() => {
      cancelled = nav.dispatchTraverse(-1);
    });
    expect(cancelled).toBe(true);
    const ask = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(ask).getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(nav.traversals).toEqual([must(nav.entries()[0]).key]));
    expect(reload()).toBe(false);
  });

  it("Back to Kobe in a panel closes it like Close: no new entry, edits asked about (L3)", async () => {
    open("/admin/site");
    const panel = await dialog("Site console");
    const back = await within(panel).findByRole("link", { name: "Back to Kobe" }, WAIT);
    const before = nav.entries().length;
    await userEvent.setup().click(back);
    await waitFor(() => expect(panelEl()).toBeNull());
    expect(nav.entries()).toHaveLength(before);
    expect(window.location.pathname).toBe("/");
  });

  it("a submitted form closes without asking", async () => {
    await openThread();
    const user = userEvent.setup();
    await user.click(await teamConsoleLink());
    const panel = await dialog("Team console");
    await user.type(within(panel).getByLabelText("Email"), "bo@example.test");
    await user.click(within(panel).getByRole("button", { name: "Invite" }));
    await user.click(within(panel).getByRole("button", { name: "Close Team console" }));
    await waitFor(() => expect(panelEl()).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a page's own unsaved edits (useUnsavedChanges) ask too, until saved", async () => {
    await openThread();
    act(() => {
      window.history.pushState({}, "", "/me/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const user = userEvent.setup();
    const panel = await dialog("My agents");
    await user.click(within(panel).getByRole("button", { name: "Edit the prompt" }));
    await user.click(within(panel).getByRole("button", { name: "Close My agents" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    await user.click(within(panel).getByRole("button", { name: "Save the prompt" }));
    await user.click(within(panel).getByRole("button", { name: "Close My agents" }));
    await waitFor(() => expect(panelEl()).toBeNull());
  });
});

describe("permissions (KOBE-452 ac-4)", () => {
  it("a member never gets the Team console's entry point", async () => {
    fake.teamRole = "member";
    await openThread();
    await waitFor(() => expect(fake.requests.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole("link", { name: "Team console" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Site console" })).toBeNull();
  });

  it("a link to a console the member can't open shows the console's refusal, no page", async () => {
    open("/admin/site");
    const panel = await dialog("Site console");
    expect(
      await within(panel).findByText(/You don't have access to the Site console/, {}, WAIT),
    ).toBeTruthy();
    expect(within(panel).queryByRole("heading", { level: 1, name: "Users" })).toBeNull();
    // In a panel the console leaves its brand (the way back) to the panel's Close.
    expect(within(panel).queryByRole("link", { name: "Kobe" })).toBeNull();
  });
});
