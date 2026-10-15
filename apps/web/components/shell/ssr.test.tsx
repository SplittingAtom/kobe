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

  it("renders the theme toggle with both icons; CSS picks one before any script runs (KOBE-282)", () => {
    const html = renderToString(<ChatApp />);
    const button = /<button[^>]*data-command="theme"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
    expect(button).toContain('data-theme-icon="light"');
    expect(button).toContain('data-theme-icon="dark"');
    // The server cannot know the OS setting: the pressed state waits for the client.
    expect(button).not.toContain("aria-pressed");
  });
});
