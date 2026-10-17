// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge } from "./badge";
import { Button } from "./button";
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
