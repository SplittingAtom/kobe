// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "./testing";

/** KOBE-200 (CE6, CE7): the artifact column's tabs, auto-open, resize and per-thread memory. */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A thread with an exchange and markdown artifacts with these titles. */
function threadWith(title: string, ...artifacts: string[]) {
  const t = fake.addThread(title);
  const u = fake.addEntry(t, null, { role: "user", content: "make them" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const ids = artifacts.map((a) =>
    fake.addArtifact(t, { kind: "markdown", title: a, versions: [`${a} body`] }),
  );
  return { t, ids };
}

const region = (name: string) =>
  must(document.querySelector<HTMLElement>(`[data-shell-region="${name}"]`));
const tabNames = () =>
  screen
    .queryAllByRole("tab")
    .map((t) => `${t.textContent}${t.getAttribute("aria-selected") === "true" ? "*" : ""}`);

async function openFromList(user: ReturnType<typeof userEvent.setup>, title: string) {
  const list = await screen.findByRole("navigation", {
    name: "Artifacts and files in this conversation",
  });
  await user.click(within(list).getByRole("button", { name: `Open artifact ${title}` }));
  await screen.findByRole("tab", { name: title, selected: true });
}

function switchTo(threadId: string) {
  act(() => {
    window.history.pushState(null, "", `/?thread=${threadId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("tabs (ac-1)", () => {
  it("open in order of opening, switch, and close; the column is gone with the last tab", async () => {
    const { t } = threadWith("Reports", "Plan", "Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await screen.findByLabelText("Message");
    expect(region("artifact").childElementCount).toBe(0); // no tabs, no column (ac-2)

    await openFromList(user, "Budget");
    await openFromList(user, "Plan");
    expect(tabNames()).toEqual(["Budget", "Plan*"]);
    const panel = screen.getByRole("tabpanel");
    expect(await within(panel).findByText("Plan body")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Plan" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Budget" }));
    expect(tabNames()).toEqual(["Budget*", "Plan"]);
    expect(await within(screen.getByRole("tabpanel")).findByText("Budget body")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close Budget" }));
    expect(tabNames()).toEqual(["Plan*"]);
    await user.click(screen.getByRole("button", { name: "Close Plan" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(region("artifact").childElementCount).toBe(0);
  });

  it("is keyboard-operable: arrows and Home/End move between tabs, Delete closes one", async () => {
    const { t } = threadWith("Reports", "A", "B", "C");
    openApp(fake, t);
    const user = userEvent.setup();
    for (const title of ["A", "B", "C"]) await openFromList(user, title);
    screen.getByRole("tab", { name: "C" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(tabNames()).toEqual(["A*", "B", "C"]);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "A" }));
    await user.keyboard("{End}");
    expect(tabNames()).toEqual(["A", "B", "C*"]);
    await user.keyboard("{ArrowLeft}");
    expect(tabNames()).toEqual(["A", "B*", "C"]);
    // One tab stop: only the active tab is focusable.
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    await user.keyboard("{Delete}");
    expect(tabNames()).toEqual(["A", "C*"]);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "C" }));
  });
});

describe("auto-open (ac-1)", () => {
  it("an artifact the agent creates opens as the active tab without taking focus", async () => {
    const { t } = threadWith("Live", "Older");
    openApp(fake, t);
    const user = userEvent.setup();
    await openFromList(user, "Older");
    // A key that changes nothing (one tab) must not leave the strip waiting to take focus.
    screen.getByRole("tab", { name: "Older" }).focus();
    await user.keyboard("{ArrowRight}");
    const input = await composer();
    await user.type(input, "make a doc{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    input.focus();

    const id = fake.addArtifact(t, { kind: "markdown", title: "Notes", versions: ["v-one"] });
    fake.agent.toolCall(runId, "tc1", "create_artifact", { kind: "markdown", title: "Notes" });
    fake.emit(runId, "artifact.created", {
      artifact_id: id,
      tool_call_id: "tc1",
      kind: "markdown",
      title: "Notes",
      version: 1,
    });
    await waitFor(() => expect(tabNames()).toEqual(["Older", "Notes*"]));
    expect(await within(screen.getByRole("tabpanel")).findByText("v-one")).toBeTruthy();
    expect(document.activeElement).toBe(input);

    // An update doesn't reopen a closed tab.
    await user.click(screen.getByRole("button", { name: "Close Notes" }));
    must(fake.artifacts.get(id)).versions.push("v-two");
    fake.emit(runId, "artifact.updated", { artifact_id: id, tool_call_id: "tc2", version: 2 });
    await waitFor(() =>
      expect(fake.requests.filter((r) => r.path.includes("thread_id"))).toHaveLength(3),
    );
    expect(tabNames()).toEqual(["Older*"]);
  });
});

describe("resize (ac-2)", () => {
  const box = (left: number, width: number) =>
    ({ left, width, right: left + width, top: 0, height: 800, x: left, y: 0 }) as DOMRect;

  async function withColumn() {
    const { t } = threadWith("Reports", "Plan");
    openApp(fake, t);
    await openFromList(userEvent.setup(), "Plan");
    // 1,000 px right of a 280 px rail, shared half and half.
    vi.spyOn(region("artifact"), "getBoundingClientRect").mockReturnValue(box(280, 500));
    vi.spyOn(region("conversation"), "getBoundingClientRect").mockReturnValue(box(780, 500));
    const handle = screen.getByRole("separator", {
      name: "Resize the artifact column and the conversation",
    });
    const grid = must(region("artifact").parentElement);
    return { handle, width: () => grid.style.getPropertyValue("--kobe-artifact-width") };
  }

  it("defaults to half the space, and the keyboard holds the 360 and 400 px floors", async () => {
    const { handle, width } = await withColumn();
    expect(width()).toBe(""); // the CSS default: half the space right of the rail
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    expect(width()).toBe("524px");
    await user.keyboard("{End}");
    expect(width()).toBe("600px"); // 1,000 − the conversation's 400
    expect(handle.getAttribute("aria-valuemax")).toBe("600");
    await user.keyboard("{Home}");
    expect(width()).toBe("360px");
    expect(handle.getAttribute("aria-valuemin")).toBe("360");
  });

  it("drags within the floors and commits on release", async () => {
    const { handle, width } = await withColumn();
    fireEvent.pointerDown(handle, { clientX: 780, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 }); // 100 px: under the floor
    expect(width()).toBe("360px");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    fireEvent.pointerMove(handle, { clientX: 1270, pointerId: 1 }); // the conversation's floor
    expect(width()).toBe("600px");
    fireEvent.pointerUp(handle, { clientX: 1270, pointerId: 1 });
    // Committed: the width survives the column re-rendering (another tab, same width).
    await openFromList(userEvent.setup(), "Plan");
    expect(width()).toBe("600px");
  });
});

describe("per-thread memory (ac-3)", () => {
  it("a reload restores the open tabs and the active tab", async () => {
    const { t } = threadWith("Reports", "Plan", "Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await openFromList(user, "Plan");
    await openFromList(user, "Budget");
    await user.click(screen.getByRole("tab", { name: "Plan" }));
    cleanup();

    openApp(fake, t);
    await waitFor(() => expect(tabNames()).toEqual(["Plan*", "Budget"]));
    expect(await within(screen.getByRole("tabpanel")).findByText("Plan body")).toBeTruthy();
  });

  it("switching threads swaps the set", async () => {
    const one = threadWith("One", "Alpha");
    const two = threadWith("Two", "Beta", "Gamma");
    openApp(fake, one.t);
    const user = userEvent.setup();
    await openFromList(user, "Alpha");

    switchTo(two.t);
    await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());
    await openFromList(user, "Gamma");
    expect(tabNames()).toEqual(["Gamma*"]);

    switchTo(one.t);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha*"]));
    switchTo(two.t);
    await waitFor(() => expect(tabNames()).toEqual(["Gamma*"]));
  });

  it("drops artifacts that no longer exist and survives garbled storage", async () => {
    const { t, ids } = threadWith("Reports", "Plan");
    const gone = "00000000-0000-4000-8000-0000000000ff";
    const key = tabsKey(fake.teamId, t);
    localStorage.setItem(key, JSON.stringify({ open: [gone, must(ids[0])], active: gone }));
    openApp(fake, t);
    await waitFor(() => expect(tabNames()).toEqual(["Plan*"]));
    await waitFor(() =>
      expect(JSON.parse(must(localStorage.getItem(key)))).toEqual({
        open: [ids[0]],
        active: ids[0],
      }),
    );
    cleanup();

    localStorage.setItem(key, "{not json");
    openApp(fake, t);
    await screen.findByRole("navigation", { name: "Artifacts and files in this conversation" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(region("artifact").childElementCount).toBe(0);
  });

  it("works without storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { t } = threadWith("Reports", "Plan");
    openApp(fake, t);
    await openFromList(userEvent.setup(), "Plan");
    expect(tabNames()).toEqual(["Plan*"]);
  });
});

describe("view-only, no files (CE6)", () => {
  it("offers no editor and no files panel in the column", async () => {
    const { t } = threadWith("Reports", "Plan");
    openApp(fake, t);
    await openFromList(userEvent.setup(), "Plan");
    const column = region("artifact");
    expect(await within(column).findByText("Plan body")).toBeTruthy();
    expect(within(column).queryByRole("textbox")).toBeNull();
    expect(column.querySelector("[contenteditable]")).toBeNull();
    expect(within(column).queryByRole("region", { name: /files/i })).toBeNull();
    expect(within(column).queryByText(/workspace/i)).toBeNull();
  });
});

/** Starts a run in `t` and returns a function that has the agent create an artifact. */
async function agentIn(t: string) {
  const user = userEvent.setup();
  await user.type(await composer(), "make a doc{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  let n = 0;
  return (title: string, body = `${title} body`) => {
    const id = fake.addArtifact(t, { kind: "markdown", title, versions: [body] });
    n += 1;
    fake.emit(runId, "artifact.created", { artifact_id: id, kind: "markdown", title, version: 1 });
    return { id, user, n };
  };
}

describe("review round 1", () => {
  it("closing the last tab with no opener moves focus to the conversation", async () => {
    const t = fake.addThread("Live");
    openApp(fake, t);
    const create = await agentIn(t);
    const { user } = create("Notes");
    await waitFor(() => expect(tabNames()).toEqual(["Notes*"]));
    await user.click(screen.getByRole("button", { name: "Close Notes" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(document.activeElement?.id).toBe("kobe-chat-main");
  });

  it("names tabs from the run or the artifact when the thread's list can't be read", async () => {
    const { t, ids } = threadWith("Reports", "Plan");
    const inner = fake.fetch;
    const failing: typeof fetch = async (input, init) =>
      String(input).includes("thread_id=")
        ? new Response(null, { status: 503 })
        : inner(input, init);
    Object.defineProperty(fake, "fetch", { value: failing });
    vi.stubGlobal("fetch", failing);
    localStorage.setItem(
      tabsKey(fake.teamId, t),
      JSON.stringify({ open: [ids[0]], active: ids[0] }),
    );
    openApp(fake, t);
    await waitFor(() => expect(tabNames()).toEqual(["Plan*"])); // from the artifact's own read
    const create = await agentIn(t);
    create("Notes");
    await waitFor(() => expect(tabNames()).toEqual(["Plan", "Notes*"])); // from the event
    expect(screen.getByRole("button", { name: "Close Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Notes" })).toBeTruthy();
  });

  it("a tab keeps the member's version across a switch, without reading it again", async () => {
    const t = fake.addThread("Reports");
    fake.addEntry(t, null, { role: "user", content: "hi" });
    const plan = fake.addArtifact(t, { kind: "markdown", title: "Plan", versions: ["one", "two"] });
    fake.addArtifact(t, { kind: "markdown", title: "Budget", versions: ["b"] });
    openApp(fake, t);
    const user = userEvent.setup();
    await openFromList(user, "Plan");
    const panel = () => screen.getByRole("tabpanel");
    await within(panel()).findByText("two");
    await user.click(within(panel()).getByRole("button", { name: "Previous version" }));
    expect(await within(panel()).findByText("one")).toBeTruthy();
    await openFromList(user, "Budget");
    const reads = fake.requests.filter((r) => r.path === `/v1/artifacts/${plan}`).length;
    await user.click(screen.getByRole("tab", { name: "Plan" }));
    expect(within(panel()).getByText("Version 1 of 2")).toBeTruthy();
    expect(fake.requests.filter((r) => r.path === `/v1/artifacts/${plan}`)).toHaveLength(reads);
  });

  it("a click on the handle leaves the default width; its values follow the columns", async () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(readonly cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    const { t } = threadWith("Reports", "Plan");
    openApp(fake, t);
    await openFromList(userEvent.setup(), "Plan");
    const box = (left: number, width: number) =>
      ({ left, width, right: left + width, top: 0, height: 800, x: left, y: 0 }) as DOMRect;
    const column = vi.spyOn(region("artifact"), "getBoundingClientRect");
    column.mockReturnValue(box(280, 500));
    vi.spyOn(region("conversation"), "getBoundingClientRect").mockReturnValue(box(780, 500));
    const handle = screen.getByRole("separator", {
      name: "Resize the artifact column and the conversation",
    });
    const grid = must(region("artifact").parentElement);
    fireEvent.pointerDown(handle, { clientX: 780, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 781, pointerId: 1 }); // under the drag threshold
    fireEvent.pointerUp(handle, { clientX: 781, pointerId: 1 });
    expect(grid.style.getPropertyValue("--kobe-artifact-width")).toBe("");

    // The rail collapses: 232 px more right of it, seen without a window resize.
    column.mockReturnValue(box(48, 616));
    vi.spyOn(region("conversation"), "getBoundingClientRect").mockReturnValue(box(664, 616));
    act(() => observers.forEach((cb) => cb()));
    expect(handle.getAttribute("aria-valuenow")).toBe("616");
    expect(handle.getAttribute("aria-valuemax")).toBe("832");
  });
});
