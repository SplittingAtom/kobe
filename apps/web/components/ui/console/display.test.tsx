// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOCUS_RING } from "./focus";
import { Badge } from "./badge";
import { Button } from "./button";
import { EmbeddedPage } from "./embedded-context";
import { EmptyState } from "./empty-state";
import { Notice } from "./notice";
import { PageHeader } from "./page-header";
import { Card, Section } from "./section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "./table";

/** KOBE-294 (ac-2): the console's display primitives and buttons. */
afterEach(cleanup);

describe("PageHeader, Section and Card", () => {
  it("the page title is the h1, with its description and actions", () => {
    render(
      <PageHeader
        title="Invitations"
        description="Invitations last 14 days."
        actions={<Button>Export</Button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Invitations" })).toBeTruthy();
    expect(screen.getByText("Invitations last 14 days.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("embedded beside the thread, the title is left out; description and actions stay (KOBE-424)", () => {
    render(
      <EmbeddedPage.Provider value={true}>
        <PageHeader
          title="My memory"
          description="What Kobe remembers."
          actions={<Button>Add</Button>}
        />
      </EmbeddedPage.Provider>,
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByText("What Kobe remembers.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("a section is a region named by its h2", () => {
    render(
      <Section title="Open invitations" description="Pending and expired.">
        <Card>Body</Card>
      </Section>,
    );
    const region = screen.getByRole("region", { name: "Open invitations" });
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe("Open invitations");
    expect(within(region).getByText("Body").getAttribute("data-slot")).toBe("console-card");
  });
});

describe("Button", () => {
  it("is a plain button by default (never submits by accident), secondary unless asked", async () => {
    const onClick = vi.fn();
    render(
      <form onSubmit={() => onClick("submitted")}>
        <Button onClick={() => onClick("clicked")}>Cancel</Button>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("secondary");
    await userEvent.click(button);
    expect(onClick.mock.calls).toEqual([["clicked"]]);
  });

  it("primary, secondary and danger look different; disabled ones don't fire", async () => {
    const onClick = vi.fn();
    render(
      <>
        <Button variant="primary">Save</Button>
        <Button>Cancel</Button>
        <Button variant="danger" disabled onClick={onClick}>
          Remove
        </Button>
      </>,
    );
    const classes = ["Save", "Cancel", "Remove"].map(
      (name) => screen.getByRole("button", { name }).className,
    );
    expect(new Set(classes).size).toBe(3);
    expect(classes[2]).toContain("text-console-danger");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Table", () => {
  it("is named by its caption, with column and row headers", () => {
    render(
      <Table caption="Open invitations to Finance">
        <TableHead>
          <TableRow>
            <TableHeader>Email</TableHeader>
            <TableHeader>Role</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableRowHeader>c@x.io</TableRowHeader>
            <TableCell>Member</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole("table", { name: "Open invitations to Finance" });
    const cols = within(table).getAllByRole("columnheader");
    expect(cols.map((c) => [c.textContent, c.getAttribute("scope")])).toEqual([
      ["Email", "col"],
      ["Role", "col"],
    ]);
    expect(within(table).getByRole("rowheader").getAttribute("scope")).toBe("row");
    expect(within(table).getByRole("cell").textContent).toBe("Member");
    // Wide tables scroll inside their wrapper, not the page.
    expect(table.parentElement?.className).toContain("overflow-x-auto");
    // It fits (happy-dom lays out nothing): no extra tab stop or landmark.
    expect(table.parentElement?.getAttribute("role")).toBeNull();
    expect(table.parentElement?.hasAttribute("tabindex")).toBe(false);
  });

  it("becomes a named, focusable scroll region only while it is wider than its box", () => {
    const wide = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    const box = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    try {
      render(
        <Table caption="Agent inventory">
          <TableBody>
            <TableRow>
              <TableCell>Triage</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );
      const region = screen.getByRole("region", { name: "Agent inventory" });
      expect(region.tabIndex).toBe(0);
      expect(within(region).getByRole("table", { name: "Agent inventory" })).toBeTruthy();
    } finally {
      wide.mockRestore();
      box.mockRestore();
    }
  });
});

describe("Table: wide tables scroll in their own box (KOBE-306)", () => {
  function renderWide() {
    render(
      <Table caption="Agent inventory">
        <TableHead>
          <TableRow>
            <TableHeader>Agent</TableHeader>
            <TableHeader>
              <span className="sr-only">Actions</span>
            </TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>Triage</TableCell>
            <TableCell>…</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    return screen.getByRole("region", { name: "Agent inventory" });
  }
  const edges = (region: HTMLElement) =>
    [...(region.parentElement?.querySelectorAll("[data-edge]") ?? [])].map((e) => [
      e.getAttribute("data-edge"),
      e.getAttribute("aria-hidden"),
    ]);

  afterEach(() => vi.restoreAllMocks());

  it("fades the edge with more columns past it, following the scroll position", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    const region = renderWide();
    expect(edges(region)).toEqual([["end", "true"]]);

    act(() => {
      region.scrollLeft = 300;
      fireEvent.scroll(region);
    });
    expect(edges(region)).toEqual([
      ["start", "true"],
      ["end", "true"],
    ]);

    act(() => {
      region.scrollLeft = 600;
      fireEvent.scroll(region);
    });
    expect(edges(region)).toEqual([["start", "true"]]);
  });

  it("has no fades while the table fits", () => {
    render(
      <Table caption="Team skills">
        <TableBody>
          <TableRow>
            <TableCell>pdf-tools</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole("table", { name: "Team skills" });
    expect(table.parentElement?.parentElement?.querySelector("[data-edge]")).toBeNull();
  });

  it("keeps visually hidden cell text inside the scroll box (positioned), not the page", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    const region = renderWide();
    // An absolutely positioned `sr-only` span escapes a scroll box that is not positioned and
    // widens the page (the inventory's "Actions" header did at 390 px).
    expect(region.className.split(" ")).toEqual(
      expect.arrayContaining(["relative", "overflow-x-auto"]),
    );
  });
});

describe("EmptyState", () => {
  it("says what is missing and offers the way to add it", () => {
    render(
      <EmptyState title="No open invitations." action={<Button>Invite someone</Button>}>
        Invite someone with the form above.
      </EmptyState>,
    );
    expect(screen.getByText("No open invitations.")).toBeTruthy();
    expect(screen.getByText("Invite someone with the form above.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite someone" })).toBeTruthy();
  });
});

describe("Notice", () => {
  it("an error is announced at once; info and warnings are not unless asked", () => {
    render(
      <>
        <Notice tone="error">Could not save.</Notice>
        <Notice tone="warn">Agents are disabled.</Notice>
        <Notice title="Heads up">Info.</Notice>
        <Notice tone="warn" role="status">
          Saved with warnings.
        </Notice>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Could not save.");
    expect(screen.getByRole("status").textContent).toBe("Saved with warnings.");
    expect(screen.getByText("Agents are disabled.").closest("[role]")).toBeNull();
    expect(screen.getByText("Heads up").tagName).toBe("P");
  });

  it("each tone has its own status colours and an icon, so colour is not the only cue", () => {
    const { container } = render(
      <>
        <Notice tone="info">a</Notice>
        <Notice tone="warn">b</Notice>
        <Notice tone="error">c</Notice>
      </>,
    );
    const notices = [...container.querySelectorAll<HTMLElement>('[data-slot="console-notice"]')];
    expect(notices.map((n) => n.dataset["tone"])).toEqual(["info", "warn", "error"]);
    expect(notices[1]?.className).toContain("bg-status-attention-bg");
    expect(notices[2]?.className).toContain("bg-status-failed-bg");
    for (const n of notices) {
      expect(n.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("Badge", () => {
  it("shows its text with the tone's status colours", () => {
    render(
      <>
        <Badge>Pending</Badge>
        <Badge tone="attention">Expired</Badge>
      </>,
    );
    expect(screen.getByText("Pending").dataset["tone"]).toBe("neutral");
    const expired = screen.getByText("Expired");
    expect(expired.dataset["tone"]).toBe("attention");
    expect(expired.className).toContain("text-status-attention");
  });
});

describe("API for KOBE-295/296 (review S5)", () => {
  it("a loading button is busy and disabled, with a spinner and its label", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("asChild styles a link as a button; buttons carry their own focus ring", () => {
    render(
      <>
        <Button asChild variant="primary">
          <a href="/me/agents/new">New agent</a>
        </Button>
        <Button variant="ghost">More</Button>
      </>,
    );
    const link = screen.getByRole("link", { name: "New agent" });
    expect(link.dataset["slot"]).toBe("console-button");
    expect(link.className).toContain("bg-status-accent");
    expect(screen.getByRole("button", { name: "More" }).className).toContain(
      FOCUS_RING.split(" ")[0],
    );
  });

  it("a success notice has its own tone and icon, and passes div props through", () => {
    render(
      <Notice tone="success" id="saved" data-testid="n" actions={<Button>Undo</Button>}>
        Saved.
      </Notice>,
    );
    const notice = screen.getByTestId("n");
    expect(notice.id).toBe("saved");
    expect(notice.dataset["tone"]).toBe("success");
    expect(notice.className).toContain("bg-status-running-bg");
    expect(notice.getAttribute("role")).toBeNull();
    expect(within(notice).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("sections and cards take a heading level; the page header a back link", () => {
    render(
      <>
        <PageHeader back={<a href="/me/agents">All agents</a>} title="Triage" />
        <Section title="Versions">
          <Section title="Drafts" level={3}>
            <Card title="v2">Body</Card>
          </Section>
        </Section>
      </>,
    );
    expect(screen.getByRole("link", { name: "All agents" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Versions" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Drafts" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Drafts" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "v2" })).toBeTruthy();
  });

  it("a wide table's scroll region is named and keyboard-focusable; numeric cells align end", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    render(
      <Table caption="Spend" hideCaption>
        <TableBody>
          <TableRow>
            <TableCell numeric>12.50</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const region = screen.getByRole("region", { name: "Spend" });
    expect(region.tabIndex).toBe(0);
    expect(screen.getByRole("table", { name: "Spend" })).toBeTruthy();
    expect(region.querySelector("caption")?.className).toContain("sr-only");
    expect(screen.getByRole("cell").className).toContain("text-end");
    vi.restoreAllMocks();
  });
});
