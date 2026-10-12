// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatApp } from "../chat/chat-app";

/** The chat is server-rendered first (e2e: "the web app serves the chat"); no `document` there. */
describe("server render", () => {
  it("renders the shell without browser globals", () => {
    const html = renderToString(<ChatApp />);
    expect(html).toContain("data-kobe-chat");
    expect(html).toContain('data-bar-row="1"');
    expect(html).toContain('data-bar-row="2"');
  });
});
