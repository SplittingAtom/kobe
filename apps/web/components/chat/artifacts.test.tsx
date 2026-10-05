// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_FRAME_CSP, FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { buildCsp } from "../../lib/security/csp";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "./testing";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: "<svg><text>flow</text></svg>" })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  // The frame route is the server's: don't let happy-dom fetch it from localhost.
  const settings = (window as unknown as { happyDOM?: { settings: Record<string, boolean> } })
    .happyDOM?.settings;
  if (settings) {
    settings.disableIframePageLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
  }
  mermaid.initialize.mockClear();
  mermaid.render.mockClear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function threadWith(artifact: Parameters<FakeKobe["addArtifact"]>[1]) {
  const t = fake.addThread("Reports");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const id = fake.addArtifact(t, artifact);
  return { t, id };
}

async function openFromList(title: string) {
  const user = userEvent.setup();
  const list = await screen.findByRole("navigation", { name: "Artifacts in this conversation" });
  await user.click(within(list).getByRole("button", { name: title }));
  const panel = await screen.findByRole("region", { name: title });
  return { user, panel };
}

describe("reopening artifacts (an old thread)", () => {
  it("lists the thread's artifacts and opens one in a labelled panel", async () => {
    const { t, id } = threadWith({ kind: "markdown", title: "Plan", versions: ["# Plan v1"] });
    openApp(fake, t);
    const { panel } = await openFromList("Plan");
    expect(await within(panel).findByRole("heading", { name: "Plan v1" })).toBeTruthy();
    expect(fake.requests.some((r) => r.path === `/v1/artifacts?thread_id=${t}`)).toBe(true);
    expect(fake.requests.find((r) => r.path.endsWith("/content"))).toMatchObject({
      path: `/v1/artifacts/${id}/versions/1/content`,
      team: fake.teamId,
    });
  });

  it("shows nothing for a thread without artifacts", async () => {
    const t = fake.addThread("Plain");
    openApp(fake, t);
    await screen.findByLabelText("Message");
    expect(screen.queryByRole("navigation", { name: "Artifacts in this conversation" })).toBeNull();
  });

  it("is closed with Escape and focus returns to the opener", async () => {
    const { t } = threadWith({ kind: "markdown", title: "Plan", versions: ["x"] });
    openApp(fake, t);
    const { user, panel } = await openFromList("Plan");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
    expect(panel.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Plan" }));
  });
});

describe("versions and download", () => {
  it("opens on the latest version, steps back and forth, and downloads the shown version", async () => {
    const { t, id } = threadWith({
      kind: "markdown",
      title: "Plan",
      versions: ["first", "second"],
    });
    openApp(fake, t);
    const { user, panel } = await openFromList("Plan");
    expect(await within(panel).findByText("second")).toBeTruthy();
    expect(within(panel).getByText("Version 2 of 2")).toBeTruthy();
    expect(
      within(panel).getByRole("link", { name: "Download version 2" }).getAttribute("href"),
    ).toBe(`/v1/artifacts/${id}/versions/2/content?team=${fake.teamId}`);
    expect(
      (within(panel).getByRole("button", { name: "Next version" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(within(panel).getByRole("button", { name: "Previous version" }));
    expect(await within(panel).findByText("first")).toBeTruthy();
    expect(within(panel).getByText("Version 1 of 2")).toBeTruthy();
    expect(
      within(panel).getByRole("link", { name: "Download version 1" }).getAttribute("href"),
    ).toBe(`/v1/artifacts/${id}/versions/1/content?team=${fake.teamId}`);
    await user.click(within(panel).getByRole("button", { name: "Next version" }));
    expect(await within(panel).findByText("second")).toBeTruthy();
  });
});

describe("renderers", () => {
  it("shows html in a sandboxed frame from the frame route: scripts and forms, never same-origin, no srcdoc", async () => {
    const { t, id } = threadWith({
      kind: "html",
      title: "Page",
      versions: ["<script>document.title='x'</script>"],
    });
    openApp(fake, t);
    const { panel } = await openFromList("Page");
    const frame = (await within(panel).findByTitle("Page (version 1)")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    const src = must(frame.getAttribute("src"));
    expect(src).toBe(`/v1/artifacts/${id}/versions/1/frame?team=${fake.teamId}`);
    // The frame's CSP is the server's (D-6): inline JS allowed, network and external scripts not.
    const res = await fake.fetch(src);
    const csp = must(res.headers.get("content-security-policy"));
    expect(csp).toBe(FAKE_FRAME_CSP);
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("allow-same-origin");
    expect(fake.requests.some((r) => r.path.endsWith("/content"))).toBe(false);
  });

  it("frames svg too", async () => {
    const { t } = threadWith({ kind: "svg", title: "Logo", versions: ["<svg/>"] });
    openApp(fake, t);
    const { panel } = await openFromList("Logo");
    expect((await within(panel).findByTitle("Logo (version 1)")).tagName).toBe("IFRAME");
  });

  it("renders csv as a table", async () => {
    const { t } = threadWith({
      kind: "csv",
      title: "Sales",
      versions: ['region,total\nEU,"1,200"\nUS,900'],
    });
    openApp(fake, t);
    const { panel } = await openFromList("Sales");
    expect(await within(panel).findByRole("columnheader", { name: "total" })).toBeTruthy();
    expect(within(panel).getByRole("cell", { name: "1,200" })).toBeTruthy();
    expect(within(panel).getAllByRole("row")).toHaveLength(3);
  });

  it("renders code with its language and does not run it", async () => {
    const { t } = threadWith({
      kind: "code",
      title: "Script",
      language: "python",
      versions: ["print('hi')"],
    });
    openApp(fake, t);
    const { panel } = await openFromList("Script");
    expect(await within(panel).findByText("print('hi')")).toBeTruthy();
    expect(panel.querySelector("iframe")).toBeNull();
  });

  it("renders markdown without raw html", async () => {
    const { t } = threadWith({ kind: "markdown", title: "Doc", versions: ["<b>raw</b> **bold**"] });
    openApp(fake, t);
    const { panel } = await openFromList("Doc");
    expect(await within(panel).findByText("bold")).toBeTruthy();
    expect(panel.querySelector("b")).toBeNull();
  });

  it("renders mermaid with securityLevel strict, as an inert image", async () => {
    const { t } = threadWith({ kind: "mermaid", title: "Flow", versions: ["graph TD; A-->B"] });
    openApp(fake, t);
    const { panel } = await openFromList("Flow");
    const img = (await within(panel).findByRole("img", {
      name: "Diagram: Flow",
    })) as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict" }),
    );
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph TD; A-->B");
  });

  it("falls back to the source when mermaid cannot render", async () => {
    mermaid.render.mockRejectedValueOnce(new Error("parse"));
    const { t } = threadWith({ kind: "mermaid", title: "Bad", versions: ["not a diagram"] });
    openApp(fake, t);
    const { panel } = await openFromList("Bad");
    expect(await within(panel).findByRole("alert")).toBeTruthy();
    expect(within(panel).getByText("not a diagram")).toBeTruthy();
  });

  it("shows an error when the content cannot be loaded", async () => {
    const { t, id } = threadWith({ kind: "markdown", title: "Plan", versions: ["x"] });
    fake.failNext.set(
      `GET /v1/artifacts/${id}/versions/1/content`,
      new Response(null, { status: 404 }),
    );
    openApp(fake, t);
    const { panel } = await openFromList("Plan");
    expect(await within(panel).findByText(/not found/i)).toBeTruthy();
  });
});

describe("opening from the run", () => {
  it("the notice and the tool card open the panel, which follows the new version", async () => {
    const t = fake.addThread("Live");
    const u = fake.addEntry(t, null, { role: "user", content: "q" });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "a" }] });
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "make a doc{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);

    const id = fake.addArtifact(t, { kind: "markdown", title: "Notes", versions: ["v-one"] });
    fake.agent.toolCall(runId, "tc1", "create_artifact", {
      kind: "markdown",
      title: "Notes",
      content: "v-one",
    });
    fake.agent.toolResult(
      runId,
      "tc1",
      "create_artifact",
      JSON.stringify({ artifact_id: id, version: 1 }),
    );
    fake.emit(runId, "artifact.created", {
      artifact_id: id,
      tool_call_id: "tc1",
      kind: "markdown",
      title: "Notes",
      version: 1,
    });
    await user.click(await screen.findByRole("button", { name: "Open artifact: Notes" }));
    const panel = await screen.findByRole("region", { name: "Notes" });
    expect(await within(panel).findByText("v-one")).toBeTruthy();

    must(fake.artifacts.get(id)).versions.push("v-two");
    fake.emit(runId, "artifact.updated", { artifact_id: id, tool_call_id: "tc2", version: 2 });
    expect(await within(panel).findByText("v-two")).toBeTruthy();
    expect(within(panel).getByText("Version 2 of 2")).toBeTruthy();
  });
});

describe("switching threads", () => {
  it("closes the panel and drops the old thread's artifact list at once", async () => {
    const { t } = threadWith({ kind: "markdown", title: "Plan", versions: ["x"] });
    const other = fake.addThread("Other");
    fake.addEntry(other, null, { role: "user", content: "hi" });
    openApp(fake, t);
    await openFromList("Plan");
    window.history.pushState(null, "", `/?thread=${other}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Plan" })).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: "Artifacts in this conversation" }),
      ).toBeNull(),
    );
  });
});

describe("a failed refresh", () => {
  it("keeps the artifact on screen and says the refresh failed", async () => {
    const t = fake.addThread("Live");
    const u = fake.addEntry(t, null, { role: "user", content: "q" });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "a" }] });
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "go{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    const id = fake.addArtifact(t, { kind: "markdown", title: "Notes", versions: ["v-one"] });
    fake.emit(runId, "artifact.created", {
      artifact_id: id,
      kind: "markdown",
      title: "Notes",
      version: 1,
    });
    await user.click(await screen.findByRole("button", { name: "Open artifact: Notes" }));
    const panel = await screen.findByRole("region", { name: "Notes" });
    expect(await within(panel).findByText("v-one")).toBeTruthy();

    fake.failNext.set(`GET /v1/artifacts/${id}`, new Response(null, { status: 503 }));
    fake.emit(runId, "artifact.updated", { artifact_id: id, version: 2 });
    expect(await within(panel).findByRole("alert")).toBeTruthy();
    expect(within(panel).getByText("v-one")).toBeTruthy();
  });
});

describe("the page CSP", () => {
  it("is not loosened for artifacts: frames from this origin only, no inline scripts", () => {
    const csp = buildCsp("n0nce", { dev: false });
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-n0nce' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
