// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { InstallModelsPage } from "./install/models-page";
import { TeamModelsPage } from "./team/models-page";
import { TEAM, renderInstall, renderTeam, stubApi, summary, type RecordedCall } from "./testing";

/** KOBE-44: install Models and providers, team Models (over KOBE-40's API, snake_case wire). */
const T = "2026-10-03T10:00:00Z";
const OLLAMA = {
  id: "ollama",
  kind: "ollama",
  name: "Ollama Cloud",
  base_url: "https://ollama.com",
  allow_private_network: false,
  key_set: true,
  key_revision: 1,
  gateway_provider: "ollama",
  created_at: T,
  updated_at: T,
};
const KIMI = {
  alias: "kimi",
  provider_id: "ollama",
  model: "kimi-k2.7-code",
  label: "Kimi K2.7 Code",
  gateway_model: "ollama/kimi-k2.7-code",
  created_at: T,
  updated_at: T,
};
const IN_SYNC = {
  desired_version: 4,
  synced_version: 4,
  in_sync: true,
  last_synced_at: T,
  last_attempt_at: T,
  last_error: null,
};
const MODELS = { providers: [OLLAMA], catalog: [KIMI], gateway: IN_SYNC, configured: true };
const LISTED = {
  provider_id: "ollama",
  models: ["glm-5.3", "kimi-k2.7-code"],
  discovery: "ok",
  detail: null,
  truncated: false,
};

const bodyOf = (call: RecordedCall | undefined) =>
  JSON.parse(String(must(call).body)) as Record<string, unknown>;

beforeEach(() =>
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("install: models and providers", () => {
  it("shows providers with only whether a key is set, the catalog, and the gateway in sync", async () => {
    const calls = stubApi({ "GET /v1/install/models": [200, MODELS] });
    renderInstall(<InstallModelsPage />);
    const providers = await screen.findByRole("table", { name: /Providers/ });
    const row = within(providers).getByRole("row", { name: /Ollama Cloud/ });
    expect(row.textContent).toContain("https://ollama.com");
    expect(row.textContent).toContain("Set (revision 1)");
    const catalog = screen.getByRole("table", { name: /Catalog models/ });
    expect(within(catalog).getByRole("row", { name: /kimi/ }).textContent).toContain(
      "ollama/kimi-k2.7-code",
    );
    expect(screen.getByText("In sync: the gateway has every change.")).toBeTruthy();
    expect(calls.every((c) => !c.headers.has("x-kobe-team"))).toBe(true);
  });

  it("shows a failing gateway sync with its last error", async () => {
    stubApi({
      "GET /v1/install/models": [
        200,
        {
          ...MODELS,
          gateway: {
            ...IN_SYNC,
            synced_version: 3,
            in_sync: false,
            last_error: "bifrost_unreachable",
          },
        },
      ],
    });
    renderInstall(<InstallModelsPage />);
    expect(await screen.findByText(/Not in sync: the last attempt/)).toBeTruthy();
    expect(screen.getByText("bifrost_unreachable")).toBeTruthy();
  });

  it("adds Ollama Cloud with its endpoint and key (write-only)", async () => {
    const calls = stubApi({
      "GET /v1/install/models": [200, { ...MODELS, providers: [], catalog: [] }],
      "POST /v1/install/models/providers": [201, { provider: OLLAMA }],
    });
    renderInstall(<InstallModelsPage />);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Add a provider" });
    await user.selectOptions(within(form).getByLabelText("Kind"), "ollama");
    const name = within(form).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Ollama Cloud");
    await user.type(within(form).getByLabelText("Base URL"), "https://ollama.com");
    const key = within(form).getByLabelText("API key (optional)");
    expect(key.getAttribute("type")).toBe("password");
    await user.type(key, "sk-cloud-key");
    await user.click(within(form).getByRole("button", { name: "Add provider" }));
    expect(await screen.findByText(/Added Ollama Cloud/)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      kind: "ollama",
      name: "Ollama Cloud",
      base_url: "https://ollama.com",
      api_key: "sk-cloud-key",
      allow_private_network: false,
    });
  });

  it("asks for an id for OpenAI-compatible endpoints and offers vendor kinds once", async () => {
    const calls = stubApi({
      "GET /v1/install/models": [200, MODELS],
      "POST /v1/install/models/providers": [
        201,
        { provider: { ...OLLAMA, id: "vllm", kind: "openai_compatible", name: "vLLM" } },
      ],
    });
    renderInstall(<InstallModelsPage />);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Add a provider" });
    const kind = within(form).getByLabelText("Kind");
    expect(within(kind).getByRole("option", { name: "Ollama (added)" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.selectOptions(kind, "openai_compatible");
    await user.type(within(form).getByLabelText("ID"), "vllm");
    await user.type(within(form).getByLabelText("Base URL"), "http://vllm.models:8000");
    await user.click(within(form).getByLabelText(/Allow private network/));
    await user.click(within(form).getByRole("button", { name: "Add provider" }));
    await screen.findByText(/Added vLLM/);
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      kind: "openai_compatible",
      id: "vllm",
      name: "OpenAI-compatible endpoint",
      base_url: "http://vllm.models:8000",
      allow_private_network: true,
    });
  });

  it("changing a keyed provider's endpoint requires the key again, and says why", async () => {
    const calls = stubApi({
      "GET /v1/install/models": [200, MODELS],
      "PATCH /v1/install/models/providers/ollama": [200, { provider: OLLAMA }],
    });
    renderInstall(<InstallModelsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit Ollama Cloud" }));
    const form = screen.getByRole("form", { name: "Edit Ollama Cloud" });
    const url = within(form).getByLabelText("Base URL");
    await user.clear(url);
    await user.type(url, "https://eu.ollama.com");
    const save = within(form).getByRole("button", { name: "Save Ollama Cloud" });
    expect(save).toHaveProperty("disabled", true);
    expect(within(form).getByRole("alert").textContent).toMatch(/Enter the API key again/);
    await user.type(within(form).getByLabelText("New API key (optional)"), "sk-new");
    expect(save).toHaveProperty("disabled", false);
    await user.click(save);
    await screen.findByText(/Saved Ollama Cloud/);
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      base_url: "https://eu.ollama.com",
      api_key: "sk-new",
    });
  });

  it("shows the server's refusal (key_required_for_new_endpoint) as it is", async () => {
    stubApi({
      "GET /v1/install/models": [200, MODELS],
      "PATCH /v1/install/models/providers/ollama": [
        400,
        {
          code: "key_required_for_new_endpoint",
          message: "Changing the endpoint needs the API key again (send api_key with base_url).",
        },
      ],
    });
    renderInstall(<InstallModelsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit Ollama Cloud" }));
    const form = screen.getByRole("form", { name: "Edit Ollama Cloud" });
    await user.click(within(form).getByLabelText(/Allow private network/));
    await user.click(within(form).getByRole("button", { name: "Save Ollama Cloud" }));
    expect((await screen.findAllByRole("alert")).at(0)?.textContent).toMatch(
      /Changing the endpoint needs the API key again/,
    );
  });

  it("adds a catalog model picked from the provider's list, and asks the provider again", async () => {
    const calls = stubApi({
      "GET /v1/install/models": [200, { ...MODELS, catalog: [] }],
      "GET /v1/install/models/providers/ollama/models": [
        200,
        { ...LISTED, models: [], discovery: "unknown" },
      ],
      "POST /v1/install/models/providers/ollama/models/refresh": [200, LISTED],
      "POST /v1/install/models/catalog": [
        201,
        {
          model: {
            ...KIMI,
            alias: "glm",
            model: "glm-5.3",
            label: null,
            gateway_model: "ollama/glm-5.3",
          },
        },
      ],
    });
    renderInstall(<InstallModelsPage />);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Add a catalog model" });
    expect(await within(form).findByText(/No models listed yet/)).toBeTruthy();
    await user.click(within(form).getByRole("button", { name: "Ask the provider for its models" }));
    expect(await within(form).findByText(/2 models available/)).toBeTruthy();
    const options = [...form.querySelectorAll("datalist option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(["glm-5.3", "kimi-k2.7-code"]);
    await user.type(within(form).getByLabelText("Alias"), "glm");
    await user.type(within(form).getByLabelText("Model"), "glm-5.3");
    await user.click(within(form).getByRole("button", { name: "Add to catalog" }));
    expect(await screen.findByText(/Published glm \(ollama\/glm-5.3\)/)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST" && c.url.endsWith("/catalog")))).toEqual({
      alias: "glm",
      provider_id: "ollama",
      model: "glm-5.3",
    });
  });

  it("explains a provider that refused to list its models; the id can still be typed", async () => {
    stubApi({
      "GET /v1/install/models": [200, { ...MODELS, catalog: [] }],
      "GET /v1/install/models/providers/ollama/models": [
        200,
        { ...LISTED, models: [], discovery: "failed", detail: "401 unauthorized" },
      ],
    });
    renderInstall(<InstallModelsPage />);
    expect(
      await screen.findByText(/The provider refused to list its models: 401 unauthorized/),
    ).toBeTruthy();
  });

  it("edits and removes catalog entries", async () => {
    const calls = stubApi({
      "GET /v1/install/models": [200, MODELS],
      "GET /v1/install/models/providers/ollama/models": [200, LISTED],
      "PATCH /v1/install/models/catalog/kimi": [200, { model: { ...KIMI, label: "Kimi" } }],
      "DELETE /v1/install/models/catalog/kimi": [204],
    });
    renderInstall(<InstallModelsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit kimi" }));
    const form = screen.getByRole("form", { name: "Edit kimi" });
    const label = within(form).getByLabelText("Shown as (optional)");
    await user.clear(label);
    await user.type(label, "Kimi");
    await user.click(within(form).getByRole("button", { name: "Save kimi" }));
    await screen.findByText(/Saved kimi/);
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ label: "Kimi" });
    await user.click(screen.getByRole("button", { name: "Remove kimi" }));
    await screen.findByText(/Removed kimi from the catalog/);
    expect(summary(calls)).toContain("DELETE /v1/install/models/catalog/kimi");
  });

  it("says so when the model gateway is not configured", async () => {
    stubApi({
      "GET /v1/install/models": [200, { ...MODELS, providers: [], catalog: [], configured: false }],
    });
    renderInstall(<InstallModelsPage />);
    expect(await screen.findByText(/Model gateway: not configured/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add a provider" })).toBeNull();
  });
});

describe("team: models", () => {
  const teamModel = (alias: string, enabled: boolean, is_default: boolean) => ({
    ...KIMI,
    alias,
    label: alias === "kimi" ? "Kimi K2.7 Code" : null,
    gateway_model: `ollama/${alias}`,
    enabled,
    is_default,
  });
  const TEAM_MODELS = {
    models: [
      teamModel("glm", true, false),
      teamModel("gpt", false, false),
      teamModel("kimi", true, true),
    ],
    default: "kimi",
  };

  it("enables, disables and picks the default, on the team's header", async () => {
    const calls = stubApi({
      "GET /v1/team/models": [200, TEAM_MODELS],
      "PUT /v1/team/models/gpt": [200, TEAM_MODELS],
      "PUT /v1/team/models/glm": [200, TEAM_MODELS],
    });
    renderTeam(<TeamModelsPage />);
    const user = userEvent.setup();
    expect(await screen.findByText("Kimi K2.7 Code", { selector: "strong" })).toBeTruthy();
    await user.click(screen.getByLabelText("gpt enabled"));
    await screen.findByText(/Enabled gpt/);
    expect(bodyOf(calls.find((c) => c.url.endsWith("/gpt")))).toEqual({ enabled: true });
    await user.click(screen.getByRole("button", { name: "Make default glm" }));
    await screen.findByText(/glm is the team's default model/);
    expect(bodyOf(calls.find((c) => c.url.endsWith("/glm")))).toEqual({
      enabled: true,
      is_default: true,
    });
    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
    // A disabled model can't be the default.
    const gptRow = screen.getByRole("row", { name: /gpt/ });
    expect(within(gptRow).queryByRole("button", { name: /Make default/ })).toBeNull();
  });

  it("warns before disabling the default, and when the team has none", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const calls = stubApi({
      "GET /v1/team/models": [
        200,
        { models: [teamModel("kimi", true, true), teamModel("glm", true, false)], default: "kimi" },
      ],
    });
    renderTeam(<TeamModelsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Kimi K2.7 Code enabled"));
    expect(String(confirm.mock.calls[0])).toMatch(/team's default/);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    cleanup();
    stubApi({
      "GET /v1/team/models": [200, { models: [teamModel("glm", true, false)], default: null }],
    });
    renderTeam(<TeamModelsPage />);
    await waitFor(() => expect(screen.getByText(/No default model/)).toBeTruthy());
  });
});
