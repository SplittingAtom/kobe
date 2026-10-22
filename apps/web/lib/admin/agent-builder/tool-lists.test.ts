import { describe, expect, it } from "vitest";
import { EMPTY_FORM, type FormState } from "./form-model";
import { allowTool, allowedTools, deniedTools, denyTool, withConnectorTools } from "./tool-lists";

const JIRA = ["mcp__jira__search", "mcp__jira__create_issue"];
const form = (over: Partial<FormState> = {}): FormState => ({ ...EMPTY_FORM, name: "A", ...over });

describe("connector tools: Allowed and Denied (KOBE-476 AC4)", () => {
  it("writes a chosen connector's tools into the allow list one by one", () => {
    const f = withConnectorTools(form(), JIRA);
    expect(f.toolsAllow).toBe("mcp__jira__search\nmcp__jira__create_issue");
    expect(allowedTools(f)).toEqual(JIRA);
  });

  it("never re-allows a denied tool, and a removed connector's tools leave both lists", () => {
    const f = withConnectorTools(
      form({ toolsAllow: "read", toolsDeny: "mcp__jira__create_issue" }),
      JIRA,
    );
    expect(f.toolsAllow).toBe("read\nmcp__jira__search");
    const removed = withConnectorTools(f, [], JIRA);
    expect(removed.toolsAllow).toBe("read");
    expect(removed.toolsDeny).toBe("");
  });

  it("denying moves a tool from the allow list to the deny list, and back", () => {
    const denied = denyTool(withConnectorTools(form(), JIRA), "mcp__jira__search");
    expect(allowedTools(denied)).toEqual(["mcp__jira__create_issue"]);
    expect(deniedTools(denied)).toEqual(["mcp__jira__search"]);
    expect(denyTool(denied, "mcp__jira__search")).toEqual(denied);
    const back = allowTool(denied, "mcp__jira__search");
    expect(back.toolsDeny).toBe("");
    expect(back.toolsAllow).toBe("mcp__jira__create_issue\nmcp__jira__search");
  });

  it("writes a typed entry to the list it is added to", () => {
    expect(allowTool(form(), "bash").toolsAllow).toBe("bash");
    expect(denyTool(form(), "bash:rm *").toolsDeny).toBe("bash:rm *");
  });
});
