// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { mentionQueryAt, mentionsIn, withoutMention } from "../../lib/chat/mentions";
import { composer, openApp } from "./testing";

/**
 * KOBE-223 (CE22): `@` in the composer opens a listbox of the member's workspace files; picking
 * one writes the protocol marker into the text and shows a chip; the message carries the marker,
 * which the server turns into the absolute sandbox path.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.workspaceFiles.set("data/sales q3.csv", new Uint8Array(10));
  fake.workspaceFiles.set("reports/summary.md", new Uint8Array(10));
  fake.workspaceFiles.set("projects/p/sales-brief.md", new Uint8Array(10));
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = () =>
  fake.requests
    .filter((r) => r.method === "POST" && /\/v1\/threads\/[^/]+\/messages$/.test(r.path))
    .map((r) => r.body as { content?: string; mentions?: string[] } | undefined);
const sent = () => posts().map((b) => b?.content);
const listed = () => posts().map((b) => b?.mentions);

const picker = () => screen.findByRole("listbox", { name: "Workspace files" });

describe("the @ picker (ac-1)", () => {
  it("lists matching files; arrows and Enter pick one; the chip shows; the send carries the marker", async () => {
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "Compare @sal");
    const list = await picker();
    // The input is the combobox of the open listbox (WAI-ARIA editable combobox).
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "sales q3.csv/workspace/data",
      "sales-brief.md/workspace/projects/p",
    ]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await user.keyboard("{ArrowUp}{Enter}");
    await waitFor(() => expect(input.value).toBe("Compare @file(data/sales%20q3.csv) "));
    expect(screen.queryByRole("listbox", { name: "Workspace files" })).toBeNull();
    const chips = screen.getByRole("list", { name: "Mentioned files" });
    expect(within(chips).getByText("@data/sales q3.csv")).toBeTruthy();
    expect(within(chips).getByRole("listitem").getAttribute("title")).toBe(
      "/workspace/data/sales q3.csv",
    );
    await user.type(input, "please{Enter}");
    await waitFor(() => expect(sent()).toEqual(["Compare @file(data/sales%20q3.csv) please"]));
    // The picked path is listed: the server rewrites only listed markers.
    expect(listed()).toEqual([["data/sales q3.csv"]]);
  });

  it("a typed or pasted @file(...) is no chip and goes as literal text, without mentions", async () => {
    openApp(fake, fake.addThread("Code"));
    const user = userEvent.setup();
    const input = await composer();
    await user.click(input);
    await user.paste("```python\n@file(cfg)\n```");
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toEqual(["```python\n@file(cfg)\n```"]));
    expect(listed()).toEqual([undefined]);
  });

  it("never offers a file whose name holds invisible or format characters", async () => {
    fake.workspaceFiles.set("data/sales\u200bhidden.csv", new Uint8Array(1));
    fake.workspaceFiles.set(
      `data/sales-tags.csv${String.fromCodePoint(0xe0041)}`,
      new Uint8Array(1),
    );
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    await user.type(await composer(), "@sales");
    const options = within(await picker()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "sales q3.csv/workspace/data",
      "sales-brief.md/workspace/projects/p",
    ]);
  });

  it("Escape closes the list without picking; removing a chip removes its mention", async () => {
    openApp(fake, fake.addThread("Sales"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "@sum");
    await picker();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "Workspace files" })).toBeNull(),
    );
    expect(input.value).toBe("@sum");
    await user.clear(input);
    await user.type(input, "see @sum");
    await user.click(within(await picker()).getByRole("option", { name: /summary\.md/ }));
    await waitFor(() => expect(input.value).toBe("see @file(reports/summary.md) "));
    await user.click(screen.getByRole("button", { name: "Remove mention of summary.md" }));
    expect(input.value).toBe("see ");
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
  });

  it("while a run holds the thread, Enter picks from the open list instead of queueing", async () => {
    const threadId = fake.addThread("Busy");
    openApp(fake, threadId);
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "go{Enter}");
    await waitFor(() => expect(fake.activeRun(threadId)).toBeTruthy());
    await screen.findByRole("button", { name: "Queue" });
    await user.type(input, "then @summ");
    await picker();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input.value).toBe("then @file(reports/summary.md) "));
    expect(sent()).toEqual(["go"]);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toEqual(["go", "then @file(reports/summary.md)"]));
    expect(listed()).toEqual([undefined, ["reports/summary.md"]]);
  });

  it("stays closed without matches, so Enter still sends a message with an @", async () => {
    openApp(fake, fake.addThread("Mail"));
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "ask @alice");
    await waitFor(() =>
      expect(fake.requests.some((r) => r.path.startsWith("/v1/workspace/files/search"))).toBe(true),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toEqual(["ask @alice"]));
  });
});

describe("mention helpers", () => {
  it("reads the @ query at the caret like assistant-ui's trigger detection", () => {
    expect(mentionQueryAt("see @sal", 8)).toBe("sal");
    expect(mentionQueryAt("see @", 5)).toBe("");
    expect(mentionQueryAt("mail a@b", 8)).toBeNull();
    expect(mentionQueryAt("see @sal x", 10)).toBeNull();
    expect(mentionQueryAt("@x then", 2)).toBe("x");
  });

  it("lists distinct picked mentions only, and removes one with its trailing space", () => {
    const text = "a @file(x.csv) b @file(d/y%20z.md) c @file(x.csv) @file(cfg) @file(d/y z.md) ";
    const picked = new Set(["x.csv", "d/y z.md"]);
    expect(mentionsIn(text, picked).map((m) => [m.name, m.sandboxPath])).toEqual([
      ["x.csv", "/workspace/x.csv"],
      ["y z.md", "/workspace/d/y z.md"],
    ]);
    expect(mentionsIn(text, new Set())).toEqual([]);
    expect(withoutMention(text, "@file(x.csv)")).toBe(
      "a b @file(d/y%20z.md) c @file(cfg) @file(d/y z.md) ",
    );
  });
});
