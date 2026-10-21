// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { openApp } from "../chat/testing";
import { notebookJson } from "./testing";

/** KOBE-465: notebooks and `.py` files open from the artifact column with their run controls. */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function threadWithFile(path: string, content: string) {
  fake.workspaceFiles.set(path, enc(content));
  const thread = fake.addThread("Code");
  const u = fake.addEntry(thread, null, { role: "user", content: "hi" });
  fake.addEntry(thread, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const tab = `file:${path}`;
  localStorage.setItem(tabsKey(fake.teamId, thread), JSON.stringify({ open: [tab], active: tab }));
  return thread;
}

describe("the file tab (ac-1, ac-3)", () => {
  it("opens an .ipynb as a notebook with the conversation's kernel", async () => {
    const thread = threadWithFile(
      "work/a.ipynb",
      notebookJson([
        {
          cell_type: "code",
          id: "c1",
          metadata: {},
          source: "x = 1",
          outputs: [],
          execution_count: null,
        },
      ]),
    );
    openApp(fake, thread);
    expect(await screen.findByRole("region", { name: "Cell 1 (Code)" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Notebook" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run cell 1" }).hasAttribute("disabled")).toBe(false);
  });

  it("gives a .py file the editor and a Run pane", async () => {
    const thread = threadWithFile("job.py", "print(1)\n");
    openApp(fake, thread);
    expect(await screen.findByRole("region", { name: "Run output" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raw" })).toBeTruthy();
  });
});
