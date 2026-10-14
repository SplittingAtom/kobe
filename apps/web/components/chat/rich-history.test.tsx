// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { must } from "../../lib/testing/must";
import { browserSpaced, crushedIconButtons, openApp } from "./testing";

/**
 * KOBE-208 (CE12): rich history on a recorded thread. Reasoning collapses to its first line with
 * its duration; tool cards to a header (tool, input summary, status, duration); a large output is
 * read back only when its card opens; the answer's footer shows model, tokens, cost and time; the
 * Detail toggle opens or closes everything and follows the member across reloads.
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const at = (s: number) => `2026-10-02T10:00:${String(s).padStart(2, "0")}.000Z`;
const BIG = `row,value\n${"1,2\n".repeat(20_000)}`;

/** A recorded thread: think, run a script, read a large file (offloaded), answer. */
function recordedThread(): { thread: string; prompt: string; bigEntry: string } {
  const thread = fake.addThread("Sales chart");
  const prompt = fake.addEntry(thread, null, { role: "user", content: "Chart the sales" });
  const step = (content: unknown[], start: number) => ({
    role: "assistant",
    content,
    timestamp: Date.parse(at(start)),
  });
  const a1 = fake.addEntry(
    thread,
    prompt,
    step(
      [
        { type: "thinking", thinking: "Need the CSV first.\nThen plot it." },
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "python plot.py" } },
      ],
      1,
    ),
    { at: at(3) },
  );
  const r1 = fake.addEntry(
    thread,
    a1,
    {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "bash",
      content: [{ type: "text", text: "saved chart.png" }],
      isError: false,
    },
    { at: at(5) },
  );
  const a2 = fake.addEntry(
    thread,
    r1,
    step([{ type: "toolCall", id: "tc2", name: "read_file", arguments: { path: "sales.csv" } }], 5),
    { at: at(6) },
  );
  const bigEntry = fake.addEntry(
    thread,
    a2,
    {
      role: "toolResult",
      toolCallId: "tc2",
      toolName: "read_file",
      content: [{ type: "text", text: BIG }],
      isError: false,
    },
    { at: at(18) },
  );
  fake.addEntry(thread, bigEntry, step([{ type: "text", text: "Here is your chart." }], 18), {
    at: at(20),
  });
  fake.threadUsage.set(thread, [
    {
      run_id: "r-1",
      user_entry_id: prompt,
      models: ["bifrost/gpt-5"],
      calls: 3,
      input_tokens: 12_345,
      output_tokens: 678,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.0421,
      unpriced_calls: 0,
      estimated_calls: 0,
    },
  ]);
  return { thread, prompt, bigEntry };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

const answer = async () =>
  must(
    (await screen.findByText("Here is your chart.")).closest<HTMLElement>(
      '[data-role="assistant"]',
    ),
  );
const disclosures = (root: HTMLElement) =>
  within(root)
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"));
const regionOf = (button: HTMLElement) =>
  must(document.getElementById(must(button.getAttribute("aria-controls"))));
const isShown = (el: HTMLElement) => el.closest("[hidden]") === null;
const outputPath = (thread: string, entryId: string) =>
  `/v1/threads/${thread}/entries/${entryId}/output`;
const bodyReads = (entryId: string) =>
  fake.requests.filter((r) => r.method === "GET" && r.path.endsWith(`/entries/${entryId}/output`));
const detailToggle = () => screen.getByRole("button", { name: "Show all details" });
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);

describe("collapsed by default (ac-3)", () => {
  it("shows the answer with every reasoning block and tool card closed", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    const message = await answer();
    expect(isShown(within(message).getByText("Here is your chart."))).toBe(true);
    const toggles = disclosures(message);
    expect(toggles).toHaveLength(3);
    for (const toggle of toggles) {
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(regionOf(toggle).hidden).toBe(true);
    }
    expect(crushedIconButtons()).toEqual([]);
  });
});

describe("rendering a recorded thread (ac-1)", () => {
  it("collapses reasoning to its first line and duration; opening shows all of it", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    const message = await answer();
    const reasoning = within(message).getByRole("button", { name: /Reasoning.*step 2\.0 s/ });
    // Pi records when the step ends, not the thinking: the time says it is the step's.
    expect(within(reasoning).getByText("step 2.0 s").getAttribute("title")).toMatch(/whole step/);
    expect(reasoning.textContent).toContain("Need the CSV first.");
    expect(reasoning.textContent).not.toContain("Then plot it.");
    await userEvent.click(reasoning);
    expect(reasoning.getAttribute("aria-expanded")).toBe("true");
    expect(regionOf(reasoning).textContent).toContain("Then plot it.");
    expect(isShown(regionOf(reasoning))).toBe(true);
  });

  it("gives each tool card a header of tool, input, status and duration; full I/O on expand", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    const message = await answer();
    const card = within(message).getByRole("region", { name: "Tool call bash" });
    const header = within(card).getByRole("button", { expanded: false });
    expect(header.textContent).toContain("bash");
    expect(header.textContent).toContain("python plot.py");
    expect(header.textContent).toContain("Done");
    expect(header.textContent).toContain("2.0 s");
    await userEvent.click(header);
    const details = regionOf(header);
    expect(isShown(details)).toBe(true);
    expect(within(details).getByLabelText("Input").textContent).toContain('"command"');
    expect(within(details).getByLabelText("Output").textContent).toBe("saved chart.png");
    expect(browserSpaced(card)).toEqual([]);
  });

  it("reads a large output in full only when its card opens", async () => {
    const { thread, bigEntry } = recordedThread();
    openApp(fake, thread);
    const message = await answer();
    const card = within(message).getByRole("region", { name: "Tool call read_file" });
    const header = within(card).getByRole("button", { expanded: false });
    expect(header.textContent).toContain("sales.csv");
    expect(header.textContent).toContain("12 s");
    expect(bodyReads(bigEntry)).toHaveLength(0);

    await userEvent.click(header);
    const output = await within(regionOf(header)).findByLabelText("Output");
    await waitFor(() => expect(output.textContent).toContain("row,value"));
    expect(bodyReads(bigEntry)).toHaveLength(1);
    // Closing and opening again does not read it again.
    await userEvent.click(header);
    await userEvent.click(header);
    expect(bodyReads(bigEntry)).toHaveLength(1);
  });

  it("says so when a large output can't be read, and reads it again on Retry", async () => {
    const { thread, bigEntry } = recordedThread();
    fake.failNext.set(
      `GET ${outputPath(thread, bigEntry)}`,
      Response.json({ code: "entry_unavailable", message: "x" }, { status: 409 }),
    );
    openApp(fake, thread);
    const card = within(await answer()).getByRole("region", { name: "Tool call read_file" });
    await userEvent.click(within(card).getByRole("button", { expanded: false }));
    const alert = await within(card).findByRole("alert");
    // The preview stays readable meanwhile.
    expect(within(card).getByLabelText("Output").textContent).toContain("row,value");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(card).queryByRole("alert")).toBeNull());
    expect(bodyReads(bigEntry)).toHaveLength(2);
    await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
  });

  it("shows a failure (not a spinner) when the request itself is rejected", async () => {
    const { thread, bigEntry } = recordedThread();
    const real = fake.fetch;
    vi.spyOn(fake, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith(outputPath(thread, bigEntry))) throw new TypeError("offline");
      return real(input, init);
    });
    openApp(fake, thread);
    const card = within(await answer()).getByRole("region", { name: "Tool call read_file" });
    await userEvent.click(within(card).getByRole("button", { expanded: false }));
    expect(await within(card).findByRole("alert")).toBeTruthy();
    expect(within(card).queryByRole("status")).toBeNull();
  });

  it("shows an entry stored in object storage as its own block, read when opened", async () => {
    const thread = fake.addThread("Stored");
    const prompt = fake.addEntry(thread, null, { role: "user", content: "go" });
    const call = fake.addEntry(thread, prompt, {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc9", name: "bash", arguments: { command: "dump" } }],
    });
    const stored = fake.addEntry(
      thread,
      call,
      {
        role: "toolResult",
        toolCallId: "tc9",
        toolName: "bash",
        content: [{ type: "text", text: "dumped" }],
        isError: true,
      },
      { offloaded: true },
    );
    fake.addEntry(thread, stored, {
      role: "assistant",
      content: [{ type: "text", text: "All done." }],
    });
    openApp(fake, thread);
    const message = must(
      (await screen.findByText("All done.")).closest<HTMLElement>('[data-role="assistant"]'),
    );
    const block = within(message).getByRole("button", { name: /stored separately/ });
    expect(bodyReads(stored)).toHaveLength(0);
    await userEvent.click(block);
    const output = await within(regionOf(block)).findByLabelText("Output");
    expect(output.textContent).toBe("dumped");
    expect(within(regionOf(block)).getByText("Error")).toBeTruthy();
  });

  it("puts model, tokens in and out, cost and time in the answer's footer", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    const message = await answer();
    const footer = await within(message).findByLabelText("Answer details");
    await waitFor(() => expect(footer.textContent).toContain("bifrost/gpt-5"));
    expect(footer.textContent).toContain("12.3k in");
    expect(footer.textContent).toContain("678 out");
    expect(footer.textContent).toContain("$0.04");
    expect(must(footer.querySelector("time")).getAttribute("datetime")).toBe(at(20));
    expect(browserSpaced(footer)).toEqual([]);
  });

  it("gives each regenerated answer its own run's usage, not the sum", async () => {
    const thread = fake.addThread("Two takes");
    const first = fake.addEntry(thread, null, { role: "user", content: "Name it" });
    fake.addEntry(thread, first, {
      role: "assistant",
      content: [{ type: "text", text: "Take one" }],
    });
    const second = fake.addEntry(thread, null, { role: "user", content: "Name it" });
    fake.addEntry(thread, second, {
      role: "assistant",
      content: [{ type: "text", text: "Take two" }],
    });
    const run = (id: string, prompt: string, input: number) => ({
      run_id: id,
      user_entry_id: prompt,
      models: ["m"],
      calls: 1,
      input_tokens: input,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      unpriced_calls: 1,
      estimated_calls: 0,
    });
    fake.threadUsage.set(thread, [run("r-1", first, 111), run("r-2", second, 222)]);
    openApp(fake, thread);
    const message = must(
      (await screen.findByText("Take two")).closest<HTMLElement>('[data-role="assistant"]'),
    );
    const footer = await within(message).findByLabelText("Answer details");
    await waitFor(() => expect(footer.textContent).toContain("222 in"));
    expect(footer.textContent).not.toContain("333");
  });
});

describe("the Detail toggle (ac-2)", () => {
  it("opens and closes every reasoning block and tool card, and saves the choice", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    const message = await answer();
    const toggle = detailToggle();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    for (const d of disclosures(message)) expect(d.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ detail_expanded: true }), {
      timeout: 2_000,
    });

    // One card closed by hand stays closed until the toggle changes again.
    const first = must(disclosures(message)[0]);
    await userEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    for (const d of disclosures(message)) expect(d.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ detail_expanded: false }), {
      timeout: 2_000,
    });
  });

  it("follows the member across reloads", async () => {
    const { thread } = recordedThread();
    fake.preferences = { detail_expanded: true };
    openApp(fake, thread);
    const message = await answer();
    await waitFor(() => expect(detailToggle().getAttribute("aria-pressed")).toBe("true"));
    for (const d of disclosures(message)) expect(d.getAttribute("aria-expanded")).toBe("true");
    act(() => cleanup());

    fake.preferences = { detail_expanded: false };
    openApp(fake, thread);
    const again = await answer();
    await waitFor(() => expect(detailToggle().getAttribute("aria-pressed")).toBe("false"));
    for (const d of disclosures(again)) expect(d.getAttribute("aria-expanded")).toBe("false");
  });
});
