import { describe, expect, it } from "vitest";
import { EMPTY_FORM, type FormState } from "./form-model";
import { allowTool, allowedTools, deniedTools, denyTool, withConnectorTools } from "./tool-lists";

const JIRA = ["mcp__jira__search", "mcp__jira__create_issue"];
const form = (over: Partial<FormState> = {}): FormState => ({ ...EMPTY_FORM, name: "A", ...over });

describe("connector tools: Allowed and Denied (KOBE-476 AC4)", () => {
  it("lists the chosen connectors' tools as allowed, typed allow entries too, minus denied", () => {
    const f = form({ toolsAllow: "", toolsDeny: "mcp__jira__create_issue" });
    expect(allowedTools(f, JIRA)).toEqual(["mcp__jira__search"]);
    expect(deniedTools(f)).toEqual(["mcp__jira__create_issue"]);
    expect(allowedTools(form({ toolsAllow: "read\nmcp__jira__search" }), JIRA)).toEqual([
      "read",
      "mcp__jira__search",
      "mcp__jira__create_issue",
    ]);
  });

  it("denying a tool moves it out of the allow list into the deny list", () => {
    const f = denyTool(form({ toolsAllow: "read\nmcp__jira__search" }), "mcp__jira__search");
    expect(f.toolsAllow).toBe("read");
    expect(f.toolsDeny).toBe("mcp__jira__search");
    // Twice is the same.
    expect(denyTool(f, "mcp__jira__search")).toEqual(f);
  });

  it("allowing a connector tool back leaves an empty allow list empty (built-ins stay usable)", () => {
    const f = allowTool(form({ toolsDeny: "mcp__jira__search" }), "mcp__jira__search", JIRA);
    expect(f.toolsDeny).toBe("");
    expect(f.toolsAllow).toBe("");
  });

  it("allowing back into a restricting allow list, or a typed entry, writes it to the list", () => {
    const restricted = form({ toolsAllow: "read", toolsDeny: "mcp__jira__search" });
    expect(allowTool(restricted, "mcp__jira__search", JIRA).toolsAllow).toBe(
      "read\nmcp__jira__search",
    );
    expect(allowTool(form({ toolsDeny: "bash" }), "bash", JIRA).toolsAllow).toBe("bash");
  });

  it("adds newly chosen connectors' tools to a restricting allow list only", () => {
    expect(withConnectorTools(form(), JIRA).toolsAllow).toBe("");
    const f = withConnectorTools(
      form({ toolsAllow: "read", toolsDeny: "mcp__jira__create_issue" }),
      JIRA,
    );
    expect(f.toolsAllow).toBe("read\nmcp__jira__search");
  });
});
