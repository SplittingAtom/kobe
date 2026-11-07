// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../lib/testing/must";
import { ConsoleLayout, ConsoleMain, ConsoleWho } from "./layout";
import { SideNav, SideNavGroup, SideNavLink } from "./side-nav";

vi.mock("next/link", () => ({
  default: ({ href, ...props }: { href: string } & Record<string, unknown>) => (
    <a href={href} {...props} />
  ),
}));

/** KOBE-294 (ac-2): the console frame and its section navigation. */
afterEach(cleanup);

function renderConsole(nav?: boolean) {
  return render(
    <ConsoleLayout
      brand={<a href="/">Kobe</a>}
      headerStart={<button type="button">Team</button>}
      headerEnd={<ConsoleWho>Ada · Owner</ConsoleWho>}
      {...(nav
        ? {
            nav: (
              <SideNav label="Site console sections" toggleLabel="Section: Users" listId="nav-site">
                <SideNavGroup id="nav-people" heading="People">
                  <SideNavLink href="/admin/site/users" current>
                    Users
                  </SideNavLink>
                  <SideNavLink href="/admin/site/invites" current={false}>
                    Invitations
                  </SideNavLink>
                </SideNavGroup>
              </SideNav>
            ),
          }
        : {})}
    >
      <ConsoleMain tabIndex={-1}>
        <h1>Users</h1>
      </ConsoleMain>
    </ConsoleLayout>,
  );
}

describe("ConsoleLayout", () => {
  it("marks the console root, skips to the page, and has a header and a main landmark", () => {
    const { container } = renderConsole();
    const root = container.firstElementChild as HTMLElement;
    expect(root.hasAttribute("data-kobe-console")).toBe(true);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#console-main");
    expect(root.firstElementChild).toBe(skip);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "Kobe" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Team" })).toBeTruthy();
    expect(within(header).getByText("Ada · Owner")).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.id).toBe("console-main");
    expect(main.tabIndex).toBe(-1);
  });

  it("in a panel (KOBE-452) leaves the brand out and keeps the switcher, who and the toggle", () => {
    const { container } = render(
      <ConsoleLayout
        panel
        brand={<a href="/">Kobe</a>}
        headerStart={<button type="button">Team</button>}
        headerEnd={<ConsoleWho>Ada · Owner</ConsoleWho>}
      >
        <ConsoleMain tabIndex={-1}>
          <h1>Users</h1>
        </ConsoleMain>
      </ConsoleLayout>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.hasAttribute("data-kobe-console")).toBe(true);
    expect(root.className).toContain("min-h-full");
    expect(root.className).not.toContain("min-h-screen");
    expect(screen.queryByRole("link", { name: "Kobe" })).toBeNull();
    // The panel's own header is the dialog's; no second banner inside it.
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByRole("button", { name: "Team" })).toBeTruthy();
    expect(screen.getByText("Ada · Owner")).toBeTruthy();
    expect(screen.getByRole("main").id).toBe("console-main");
  });

  it("takes two columns on wide screens only with a section navigation", () => {
    const grid = (c: HTMLElement) => c.querySelector("header + div")?.className ?? "";
    const { container, unmount } = renderConsole(false);
    expect(grid(container)).not.toContain("md:grid-cols-[15rem_minmax(0,1fr)]");
    unmount();
    expect(grid(renderConsole(true).container)).toContain("md:grid-cols-[15rem_minmax(0,1fr)]");
  });

  it("lays the sidebar and the page out as cards with a 16 px gap and gutter (KOBE-554)", () => {
    const { container } = renderConsole(true);
    const grid = must(container.querySelector<HTMLElement>("header + div"));
    expect(grid.className).toContain("gap-4");
    expect(grid.className).toContain("p-4");
    const cards = [...grid.children] as HTMLElement[];
    expect(cards.map((c) => c.getAttribute("data-console-region"))).toEqual(["nav", "content"]);
    for (const card of cards) {
      for (const cls of ["kobe-panel", "bg-card", "border", "rounded-lg"]) {
        expect(card.classList.contains(cls), cls).toBe(true);
      }
    }
    expect(within(cards[0] as HTMLElement).getByRole("navigation")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByRole("main")).toBeTruthy();
    // The sidebar's own edge borders and panel colour went: the card draws the edge.
    const nav = screen.getByRole("navigation");
    expect(nav.className).not.toMatch(/border-r|border-b|bg-console-panel/);
  });

  it("without a section navigation, the page alone is a card", () => {
    const { container } = renderConsole(false);
    const grid = must(container.querySelector<HTMLElement>("header + div"));
    expect([...grid.children].map((c) => c.getAttribute("data-console-region"))).toEqual([
      "content",
    ]);
  });
});

describe("SideNav", () => {
  it("is a named landmark whose groups name their lists, with the current page marked", () => {
    renderConsole(true);
    const nav = screen.getByRole("navigation", { name: "Site console sections" });
    const list = within(nav).getByRole("list", { name: "People" });
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Users", "Invitations"]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links[1]?.hasAttribute("aria-current")).toBe(false);
  });

  it("folds behind a toggle on narrow screens; following a link folds it again", async () => {
    const { container } = renderConsole(true);
    const toggle = screen.getByRole("button", { name: "Section: Users" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = container.querySelector(`#${toggle.getAttribute("aria-controls") ?? "none"}`);
    expect(list?.className).toContain("max-md:hidden");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list?.className).not.toContain("max-md:hidden");
    await userEvent.click(screen.getByRole("link", { name: "Invitations" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
