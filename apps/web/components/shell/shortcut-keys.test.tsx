// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { chatRequests, composer, openApp, streaming } from "../chat/testing";

/**
 * KOBE-225 (CE23): each of the twelve shortcuts runs its command's binding (ac-2), the `?` sheet
 * lists them, tooltips name them, and none fires from a text field (but the palette, Stop and
 * Steer), during IME composition, over a dialog, or from an artifact's iframe.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  fake = new FakeKobe();
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true },
    { alias: "glm", label: "GLM 5.3", enabled: true, is_default: false },
  );
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MOD = () => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

/**
 * A press of `Mod` + key (with `extra`) on `target` (the page, by default); false when something
 * prevented the browser's default.
 */
function press(key: string, extra: Partial<KeyboardEventInit> = {}, target?: Element): boolean {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : undefined;
  return fireEvent.keyDown(target ?? document.body, { key, code, ...MOD(), ...extra });
}

type Place = "page" | "composer";

/**
 * A shortcut's press where the member is: on the page, or in the message box (where the focus
 * usually is). Either way the browser's own action for the chord (Cmd+[ is Back) is prevented.
 */
function hitIn(place: Place) {
  return (key: string, extra: Partial<KeyboardEventInit> = {}) => {
    const box = document.getElementById("kobe-composer");
    let target: Element = document.body;
    if (place === "composer" && box) {
      act(() => box.focus());
      target = box;
    }
    expect(press(key, extra, target)).toBe(false);
  };
}

/** An idle thread with one exchange under Pi's first entries (so its question can be edited). */
function conversation(title: string, answer = "They add up to 42.") {
  const t = fake.addThread(title);
  const first = fake.addSystemEntry(t, null, "model_change", { provider: "kobe", modelId: "kimi" });
  const root = fake.addSystemEntry(t, first, "thinking_level_change", { thinkingLevel: "off" });
  const q = fake.addEntry(t, root, { role: "user", content: `About ${title}` });
  fake.addEntry(t, q, { role: "assistant", content: [{ type: "text", text: answer }] });
  return t;
}

async function opened(t: string, answer = "They add up to 42.") {
  openApp(fake, t);
  await screen.findByText(answer, undefined, WAIT);
  // The open thread's bindings are published once its controls were read.
  await screen.findByRole("combobox", { name: "Model for this conversation" }, WAIT);
}

/** A shared thread opened by its link: no composer, so wait for the reader's banner. */
async function openShared(t: string) {
  openApp(fake, t);
  await screen.findByText("They add up to 42.", undefined, WAIT);
  await screen.findByText(/You are reading a shared conversation/, undefined, WAIT);
}

const status = () =>
  (document.querySelector("[data-kobe-shortcut-status]")?.textContent ?? "").replace(/\u00a0/g, "");
// By selector: an open dialog hides the rest from the accessibility tree.
const rail = () => must(document.querySelector<HTMLElement>('aside[aria-label="Workspace"]'));
const threadParam = () => new URL(window.location.href).searchParams.get("thread");

describe.each<Place>(["page", "composer"])(
  "the twelve shortcuts run their actions, pressed on the %s (ac-2)",
  { timeout: 30_000 },
  (place) => {
    const hit = hitIn(place);

    it("Mod+K opens the palette, also from the composer; Mod+K again closes it", async () => {
      await opened(conversation("Report"));
      press("k");
      const dialog = await screen.findByRole("dialog", { name: "Command palette" });
      expect(within(dialog).getByRole("combobox")).toBe(document.activeElement);
      press("k", {}, document.activeElement ?? undefined);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const input = await composer();
      input.focus();
      press("k", {}, input);
      await screen.findByRole("dialog", { name: "Command palette" });
    });

    it("Mod+N starts a new conversation, and so does its alias Mod+Shift+O", async () => {
      const t = conversation("Report");
      await opened(t);
      expect(threadParam()).toBe(t);
      hit("n");
      await waitFor(() => expect(threadParam()).toBeNull());
      window.history.back();
      await waitFor(() => expect(threadParam()).toBe(t));
      await screen.findByText("They add up to 42.", undefined, WAIT);
      hit("O", { shiftKey: true });
      await waitFor(() => expect(threadParam()).toBeNull());
    });

    it("Mod+B collapses and expands the rail", async () => {
      await opened(conversation("Report"));
      expect(rail().hasAttribute("data-collapsed")).toBe(false);
      hit("b");
      await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
      hit("b");
      await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(false));
    });

    it("Mod+Shift+F shows the files", async () => {
      await opened(conversation("Report"));
      hit("b");
      await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
      hit("F", { shiftKey: true });
      await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(false));
      await waitFor(() =>
        expect(document.activeElement).toBe(document.getElementById("kobe-rail-files")),
      );
    });

    it("Mod+Shift+A hides and shows the artifact column, and opens the newest when none is", async () => {
      const t = conversation("Report");
      fake.addArtifact(t, { kind: "markdown", title: "Plan", versions: ["Plan body"] });
      await opened(t);
      const column = () => must(document.getElementById("kobe-artifact-column"));
      expect(column().childElementCount).toBe(0);
      hit("A", { shiftKey: true });
      await screen.findByRole("tab", { name: "Plan", selected: true }, WAIT);
      const panel = must(column().firstElementChild);
      hit("A", { shiftKey: true });
      await waitFor(() => expect(column().hasAttribute("data-hidden")).toBe(true));
      // Hidden, not unmounted: the previews keep their state.
      expect(column().firstElementChild).toBe(panel);
      hit("A", { shiftKey: true });
      await waitFor(() => expect(column().hasAttribute("data-hidden")).toBe(false));
      expect(column().firstElementChild).toBe(panel);
    });

    it("Mod+Shift+A says why when the conversation has no artifacts", async () => {
      await opened(conversation("Report"));
      hit("A", { shiftKey: true });
      await waitFor(() =>
        expect(status()).toBe("Show the artifact column: This conversation has no artifacts yet."),
      );
    });

    it("Mod+Shift+D opens and closes every detail", async () => {
      await opened(conversation("Report"));
      const toggle = screen.getByRole("button", { name: "Show all details" });
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      hit("D", { shiftKey: true });
      await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
      hit("D", { shiftKey: true });
      await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    });

    it("Mod+. stops the run, also from the composer; Mod+Shift+Enter steers", async () => {
      const t = conversation("Report");
      await opened(t);
      const user = userEvent.setup();
      const input = await composer();
      await user.type(input, "go on{Enter}");
      await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
      const runId = must(fake.activeRun(t)).run_id;
      await streaming(fake, runId);
      await user.type(input, "shorter please");
      // From outside the composer the steer binding sends the composer's text; inside, the input.
      act(() => input.blur());
      hit("Enter", { shiftKey: true });
      await waitFor(() =>
        expect(chatRequests(fake, "POST").some((r) => r.path.endsWith("/steer"))).toBe(true),
      );
      await waitFor(() => expect(input.value).toBe(""));
      hit(".");
      await waitFor(() =>
        expect(chatRequests(fake, "POST").some((r) => r.path.endsWith("/cancel"))).toBe(true),
      );
    });

    it("Mod+. with nothing running says so and does nothing", async () => {
      await opened(conversation("Report"));
      hit(".");
      await waitFor(() => expect(status()).toBe("Stop: Nothing is running."));
      expect(chatRequests(fake, "POST")).toEqual([]);
    });

    it("Mod+Shift+E edits the last sent message", async () => {
      await opened(conversation("Report"));
      hit("E", { shiftKey: true });
      const edit = await screen.findByLabelText("Edit your message");
      await waitFor(() => expect(document.activeElement).toBe(edit));
      expect((edit as HTMLTextAreaElement).value).toBe("About Report");
    });

    it("Mod+[ and Mod+] step through the rail's conversations, and stop at the ends", async () => {
      const older = conversation("Older", "Older answer");
      const newer = conversation("Newer", "Newer answer");
      must(fake.threads.get(newer)).last_activity_at = "2030-01-01T00:00:00.000Z";
      await opened(older, "Older answer");
      await within(rail()).findByText("Newer", undefined, WAIT);
      hit("[");
      await screen.findByText("Newer answer", undefined, WAIT);
      expect(threadParam()).toBe(newer);
      hit("[");
      await waitFor(() =>
        expect(status()).toBe("Previous conversation: This is the first conversation."),
      );
      hit("]");
      await screen.findByText("Older answer", undefined, WAIT);
      expect(threadParam()).toBe(older);
    });

    it("Mod+/ puts the focus in the message box", async () => {
      await opened(conversation("Report"));
      const input = await composer();
      expect(input.getAttribute("aria-keyshortcuts")).toBe("Control+/ Meta+/");
      hit("/");
      expect(document.activeElement).toBe(input);
    });
  },
);

describe("previous and next follow the rail's exact order (ac-2)", { timeout: 30_000 }, () => {
  it("project groups by name, not by recency, then your threads", async () => {
    const alpha = fake.addProject("Alpha");
    const zeta = fake.addProject("Zeta");
    const inAlpha = conversation("Alpha work", "Alpha answer");
    const inZeta = conversation("Zeta work", "Zeta answer");
    const loose = conversation("Loose", "Loose answer");
    must(fake.threads.get(inAlpha)).project_id = alpha;
    must(fake.threads.get(inZeta)).project_id = zeta;
    // Zeta's thread is the newest: by recency its group would come first.
    must(fake.threads.get(inZeta)).last_activity_at = "2030-01-03T00:00:00.000Z";
    must(fake.threads.get(loose)).last_activity_at = "2030-01-02T00:00:00.000Z";
    await opened(inAlpha, "Alpha answer");
    const groups = () =>
      [...rail().querySelectorAll("[data-group]")].map(
        (g) => g.querySelector("[class*=groupLabel]")?.textContent,
      );
    await waitFor(() => expect(groups()).toEqual(["Alpha", "Zeta", "Your threads"]), WAIT);
    press("]");
    await screen.findByText("Zeta answer", undefined, WAIT);
    expect(threadParam()).toBe(inZeta);
    press("]");
    await screen.findByText("Loose answer", undefined, WAIT);
    press("[");
    await screen.findByText("Zeta answer", undefined, WAIT);
    press("[");
    await screen.findByText("Alpha answer", undefined, WAIT);
    expect(threadParam()).toBe(inAlpha);
  });
});

describe("the ? sheet and tooltips list them (ac-2)", { timeout: 30_000 }, () => {
  it("? opens a sheet with the twelve, in the spec's order, and gives the focus back", async () => {
    await opened(conversation("Report"));
    const before = screen.getByRole("button", { name: "Show all details" });
    before.focus();
    fireEvent.keyDown(before, { key: "?", shiftKey: true });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const rows = sheet.querySelectorAll("[data-kobe-shortcut]");
    expect(rows).toHaveLength(12);
    expect([...rows].map((r) => r.querySelector("[data-kobe-shortcut-name]")?.textContent)).toEqual(
      [
        "Search actions, threads and files",
        "New conversation",
        "Collapse or expand the rail",
        "Show the files",
        "Show or hide the artifact column",
        "Show or hide all details",
        "Stop",
        "Steer now",
        "Edit your last message",
        "Previous conversation",
        "Next conversation",
        "Go to the message box",
      ],
    );
    const mac = isMacPlatform();
    expect(rows[0]?.querySelector("kbd")?.textContent).toBe(mac ? "⌘K" : "Ctrl+K");
    expect(within(sheet).getByRole("list", { name: "Message box keys" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(before));
  });

  it("names the keys on the icons that have them", async () => {
    await opened(conversation("Report"));
    const keys = (name: string) =>
      screen.getAllByRole("button", { name }).map((b) => b.getAttribute("aria-keyshortcuts"));
    // Mod+Shift+O first: browsers keep Mod+N for a new window outside an installed app.
    expect(keys("New conversation")).toContain("Control+Shift+O Meta+Shift+O Control+N Meta+N");
    expect(keys("Collapse the rail")).toEqual(["Control+B Meta+B"]);
    expect(keys("Files")).toContain("Control+Shift+F Meta+Shift+F");
    expect(keys("Show all details")).toEqual(["Control+Shift+D Meta+Shift+D"]);
    // The last message's Edit names Mod+Shift+E.
    expect(keys("Edit")).toEqual(["Control+Shift+E Meta+Shift+E"]);
  });
});

describe("where shortcuts don't fire (ac-2)", { timeout: 30_000 }, () => {
  it("from other fields only the palette; a bare ? never from a field", async () => {
    await opened(conversation("Report"));
    const input = await composer();
    input.focus();
    // ? is typing in the message box.
    expect(fireEvent.keyDown(input, { key: "?", shiftKey: true })).toBe(true);
    const search = screen.getByRole("searchbox", { name: "Search conversations" });
    search.focus();
    // Chords from the search box stay the browser's (and the field's).
    expect(press("b", {}, search)).toBe(true);
    expect(press("D", { shiftKey: true }, search)).toBe(true);
    expect(press("n", {}, search)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(rail().hasAttribute("data-collapsed")).toBe(false);
    expect(
      screen.getByRole("button", { name: "Show all details" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(threadParam()).not.toBeNull();
    // The palette opens from any field.
    expect(press("k", {}, search)).toBe(false);
    await screen.findByRole("dialog", { name: "Command palette" });
  });

  it("leaves Shift chords of [ and ] to the browser (previous and next tab)", async () => {
    const t = conversation("Report");
    conversation("Other", "Other answer");
    await opened(t);
    const input = await composer();
    input.focus();
    expect(press("{", { shiftKey: true, code: "BracketLeft" }, input)).toBe(true);
    expect(press("}", { shiftKey: true, code: "BracketRight" }, input)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(threadParam()).toBe(t);
  });

  it("a reader of a shared thread is told why Stop and Edit don't run", async () => {
    const t = conversation("Report");
    must(fake.threads.get(t)).read_only = true;
    await openShared(t);
    expect(press(".")).toBe(false);
    await waitFor(() =>
      expect(status()).toBe("Stop: This conversation is shared with you read-only."),
    );
    expect(press("E", { shiftKey: true })).toBe(false);
    await waitFor(() =>
      expect(status()).toBe(
        "Edit your last message: This conversation is shared with you read-only.",
      ),
    );
    expect(screen.queryByLabelText("Edit your message")).toBeNull();
    expect(chatRequests(fake, "POST")).toEqual([]);
  });

  it("not during IME composition, nor over an open dialog", async () => {
    await opened(conversation("Report"));
    press("b", { isComposing: true } as Partial<KeyboardEventInit>);
    press("b", { keyCode: 229 });
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    press("b");
    press("k");
    await new Promise((r) => setTimeout(r, 50));
    expect(rail().hasAttribute("data-collapsed")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("not from an artifact's iframe, which has the focus", async () => {
    await opened(conversation("Report"));
    // An artifact preview's frame (the real one is sandboxed and cross-origin).
    const frame = document.createElement("iframe");
    frame.title = "Preview";
    must(document.getElementById("kobe-artifact-column")).append(frame);
    frame.focus();
    expect(document.activeElement).toBe(frame);
    // A key the frame forwarded to the page anyway (it never does: sandboxed, cross-origin).
    press("b", {}, frame);
    press("k", {}, frame);
    // And in the frame's own document, the page's listener never hears it.
    const inner = frame.contentDocument;
    if (inner) fireEvent.keyDown(inner.body ?? inner, { key: "b", ...MOD() });
    await new Promise((r) => setTimeout(r, 50));
    expect(rail().hasAttribute("data-collapsed")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    frame.remove();
  });

  it("not over a control that handled the key first (Escape keeps its own meaning)", async () => {
    await opened(conversation("Report"));
    const body = document.body;
    const handled = (e: KeyboardEvent) => e.preventDefault();
    body.addEventListener("keydown", handled, { capture: true });
    press("b");
    body.removeEventListener("keydown", handled, { capture: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(rail().hasAttribute("data-collapsed")).toBe(false);
  });
});
